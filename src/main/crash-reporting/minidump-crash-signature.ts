// Extracts the diagnosable parts of a Crashpad minidump without symbols.
//
// Why: a Chromium CHECK/DCHECK surfaces to `render-process-gone` as exit code
// 0x80000003 (STATUS_BREAKPOINT) and nothing else, so the exit code alone can
// never name the failing check. Some Crashpad builds expose the fatal line as
// `LOG_FATAL`; Electron 43 on Windows only carries it in captured process
// memory. Both forms are recoverable without symbols or minidump_stackwalk.
//
// Layouts are from Crashpad's minidump_extensions.h and the Windows
// MINIDUMP_* structs. Everything here is bounds-checked and returns null
// rather than throwing: a truncated dump must degrade, not break crash
// reporting.

import { findStream, isMinidump, MinidumpView } from './minidump-stream-reader'
import { readCrashpadAnnotations } from './minidump-crashpad-annotations'
import {
  chromiumLinkedImageNames,
  dumpPathBasename,
  type FaultingModuleResolution,
  resolveFaultingModule
} from './minidump-faulting-module'

const STREAM_TYPE_EXCEPTION = 6

// MINIDUMP_EXCEPTION_STREAM: ThreadId u32, __alignment u32, then MINIDUMP_EXCEPTION.
const EXCEPTION_RECORD_OFFSET = 8
const EXCEPTION_CODE_OFFSET = EXCEPTION_RECORD_OFFSET + 0
const EXCEPTION_ADDRESS_OFFSET = EXCEPTION_RECORD_OFFSET + 16

const CHROMIUM_LOG_MARKERS = [
  Buffer.from(':FATAL:', 'ascii'),
  Buffer.from(':CHECK:', 'ascii'),
  Buffer.from(':DFATAL:', 'ascii'),
  Buffer.from(':ERROR:', 'ascii')
]
const MAX_LOG_PREFIX_BYTES = 96
const MAX_CHECK_LOG_BYTES = 4_000
const MAX_MARKERS_PER_SEVERITY = 256
const CHECK_LOG_PATTERN =
  /^\[(?:\d+:){1,2}\d{4}\/\d{6}\.\d{3,6}:(FATAL|CHECK|DFATAL|ERROR)(?::[^:\]\r\n]{1,80})*:([^:\]\r\n]{1,512}?)(?:\((\d+)\)|:(\d+))\]\s*(.+)$/
const ERROR_CHECK_PATTERN = /\b(?:Check failed:|D?CHECK failed:|Intentionally causing D?CHECK\b)/i

export type MinidumpCrashSignature = {
  /** Chromium's fatal log line, e.g. `[...:FATAL:node.cc(123)] Check failed: !x.` */
  readonly checkMessage?: string
  /** Source file basename parsed out of `checkMessage`. */
  readonly checkFile?: string
  readonly checkLine?: number
  /** Crashpad `ptype`: `renderer`, `gpu-process`, `browser`. */
  readonly processType?: string
  /** Win32 exception code / POSIX signal, e.g. 0x80000003 STATUS_BREAKPOINT. */
  readonly exceptionCode?: number
  /** Win32 exception address, or POSIX `siginfo.si_addr` — the faulting data address. */
  readonly exceptionAddress?: string
  /** Module holding the crashing instruction, or why it could not be named. */
  readonly faultingModule?: FaultingModuleResolution
  /** Allowlisted Crashpad annotations, verbatim. */
  readonly annotations: Readonly<Record<string, string>>
}

function toHex(value: bigint): string {
  return `0x${value.toString(16)}`
}

type LocatedCheckMessage = {
  readonly message: string
  readonly file?: string
  readonly line?: number
}

function isPrintableLogByte(value: number): boolean {
  return value === 0x09 || (value >= 0x20 && value <= 0x7e)
}

/**
 * `lastIndexOf(byte, from)` restricted to `within` bytes before `from`. An
 * unbounded search scans the whole dump backward on a miss only for the result
 * to be thrown away by the same prefix limit; zero-filled regions are normal in
 * a minidump, so that miss is the common case, not the adversarial one.
 */
function lastIndexOfWithin(dump: Buffer, byte: number, from: number, within: number): number {
  const floor = Math.max(0, from - within)
  for (let at = from; at >= floor; at -= 1) {
    if (dump[at] === byte) {
      return at
    }
  }
  return -1
}

/** Electron 43 omits LOG_FATAL but keeps Chromium's formatted log line in memory. */
function findEmbeddedCheckMessage(dump: Buffer): LocatedCheckMessage | undefined {
  for (const marker of CHROMIUM_LOG_MARKERS) {
    let from = 0
    for (let inspected = 0; inspected < MAX_MARKERS_PER_SEVERITY; inspected += 1) {
      const markerAt = dump.indexOf(marker, from)
      if (markerAt === -1) {
        break
      }
      from = markerAt + marker.length
      const start = lastIndexOfWithin(dump, 0x5b, markerAt, MAX_LOG_PREFIX_BYTES)
      if (start === -1) {
        continue
      }
      let end = markerAt + marker.length
      const limit = Math.min(dump.length, start + MAX_CHECK_LOG_BYTES)
      while (end < limit && isPrintableLogByte(dump[end])) {
        end += 1
      }
      const candidate = dump.subarray(start, end).toString('utf8')
      const match = CHECK_LOG_PATTERN.exec(candidate)
      if (!match || (match[1] === 'ERROR' && !ERROR_CHECK_PATTERN.test(match[5]))) {
        continue
      }
      const line = Number.parseInt(match[3] ?? match[4], 10)
      return {
        message: candidate,
        file: dumpPathBasename(match[2]),
        line: Number.isFinite(line) ? line : undefined
      }
    }
  }
  return undefined
}

/** Parses the annotation form, which uses `file.cc(123)`. */
function parseCheckLocation(checkMessage: string): {
  file?: string
  line?: number
} {
  const match = /:(?:FATAL|CHECK|DFATAL)(?::[^:\]]*)?:([^:()\s]+)\((\d+)\)/.exec(checkMessage)
  if (!match) {
    return {}
  }
  const line = Number.parseInt(match[2], 10)
  return { file: match[1], line: Number.isFinite(line) ? line : undefined }
}

export type MinidumpParseOptions = {
  /**
   * Process type the caller will accept. A dump from any other process is
   * discarded by the caller anyway, so parsing stops at `processType` and the
   * returned signature is deliberately partial — read only `processType` when
   * it does not match.
   */
  readonly expectedProcessType?: string
  /**
   * Basenames of the images Chromium is statically linked into, so a hit on one
   * is not read as localizing the fault. Defaults to the running executable.
   */
  readonly productImageNames?: readonly string[]
}

/**
 * Parses a Crashpad minidump into the fields that make a CHECK failure
 * nameable. Returns null when the buffer is not a minidump.
 */
export function parseMinidumpCrashSignature(
  dump: Buffer,
  options: MinidumpParseOptions = {}
): MinidumpCrashSignature | null {
  if (!isMinidump(dump)) {
    return null
  }
  const view = new MinidumpView(dump)
  const annotations = readCrashpadAnnotations(view)

  const signature: {
    -readonly [K in keyof MinidumpCrashSignature]: MinidumpCrashSignature[K]
  } = { annotations }

  const processType = annotations['ptype']
  if (processType) {
    signature.processType = processType
  }
  // Annotations are bounded; the scans below are not. A renderer crash would
  // otherwise scan every fresh GPU/utility dump end to end before rejecting it.
  if (options.expectedProcessType !== undefined && processType !== options.expectedProcessType) {
    return signature
  }

  const annotatedCheckMessage = annotations['LOG_FATAL'] ?? annotations['abort-message']
  const embeddedCheck = annotatedCheckMessage ? undefined : findEmbeddedCheckMessage(dump)
  const checkMessage = annotatedCheckMessage ?? embeddedCheck?.message
  if (checkMessage) {
    signature.checkMessage = checkMessage
    const location = embeddedCheck ?? parseCheckLocation(checkMessage)
    if (location.file) {
      signature.checkFile = location.file
    }
    if (location.line !== undefined) {
      signature.checkLine = location.line
    }
  }
  const exception = findStream(view, STREAM_TYPE_EXCEPTION)
  const address = exception ? view.u64(exception.rva + EXCEPTION_ADDRESS_OFFSET) : null
  if (exception) {
    const code = view.u32(exception.rva + EXCEPTION_CODE_OFFSET)
    if (code !== null) {
      signature.exceptionCode = code
    }
    if (address !== null) {
      signature.exceptionAddress = toHex(address)
    }
  }
  signature.faultingModule = resolveFaultingModule(
    view,
    exception,
    address,
    options.productImageNames ?? chromiumLinkedImageNames()
  )

  return signature
}

/** Flattens a signature into `CrashReportRecord.details` keys. */
export function minidumpSignatureDetails(
  signature: MinidumpCrashSignature
): Record<string, string | number> {
  const details: Record<string, string | number> = {}
  if (signature.checkMessage) {
    details.minidumpCheckMessage = signature.checkMessage
  }
  if (signature.checkFile) {
    details.minidumpCheckFile = signature.checkFile
  }
  if (signature.checkLine !== undefined) {
    details.minidumpCheckLine = signature.checkLine
  }
  if (signature.processType) {
    details.minidumpProcessType = signature.processType
  }
  if (signature.exceptionCode !== undefined) {
    details.minidumpExceptionCode = `0x${(signature.exceptionCode >>> 0).toString(16)}`
  }
  if (signature.exceptionAddress) {
    details.minidumpExceptionAddress = signature.exceptionAddress
  }
  const faulting = signature.faultingModule
  if (faulting) {
    details.minidumpFaultingModuleState = faulting.state
    if (faulting.state === 'resolved') {
      details.minidumpFaultingModule = faulting.module
      details.minidumpFaultingModuleOffset = faulting.offset
      details.minidumpFaultingModuleIdentity = faulting.identity
      details.minidumpFaultingModuleAddressSource = faulting.addressSource
    } else {
      details.minidumpFaultingModuleReason = faulting.reason
    }
  }
  for (const [key, value] of Object.entries(signature.annotations)) {
    if (key === 'LOG_FATAL' || key === 'abort-message' || key === 'ptype') {
      continue
    }
    details[`minidumpAnnotation_${key.replace(/-/g, '_')}`] = value
  }
  return details
}
