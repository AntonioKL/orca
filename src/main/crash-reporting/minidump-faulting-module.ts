// Names the module holding the instruction that crashed, or says why it cannot.
//
// Two things make the naive "module whose range contains ExceptionAddress"
// answer wrong:
//
//  - That field is the instruction pointer only on Windows. Crashpad fills it
//    from siginfo.si_addr on POSIX, so for SIGSEGV/SIGBUS it is the faulting
//    *data* address; a module resolved from it owns the bad pointer, not the
//    code that dereferenced it. The instruction pointer lives in the exception
//    stream's thread context, so POSIX dumps are read from there instead.
//  - Electron statically links Chromium, V8 and Blink into one image, so every
//    Chromium-side fault lands in that image and the name says nothing beyond
//    "in-process". A separately loaded module (a GPU driver, KERNELBASE.dll)
//    does localize the fault, so the two are told apart by the module's own
//    recorded name, never by its index or size.
//
// The answer is three-state on purpose: a field we could not read is never
// reported as a field that was not there. Reading a pointer out of the wrong
// CONTEXT layout produces a confident wrong answer, so a layout is only used
// when the stored ContextFlags independently name the CPU SYSTEM_INFO claims.

import {
  findStream,
  type LocationDescriptor,
  MAX_MODULES,
  type MinidumpView
} from './minidump-stream-reader'

const STREAM_TYPE_MODULE_LIST = 4
const STREAM_TYPE_SYSTEM_INFO = 7

const MODULE_RECORD_SIZE = 108
const MODULE_BASE_OFFSET = 0
const MODULE_SIZE_OFFSET = 8
const MODULE_NAME_RVA_OFFSET = 20

// MINIDUMP_SYSTEM_INFO.
const SYSTEM_INFO_ARCHITECTURE_OFFSET = 0
const SYSTEM_INFO_PLATFORM_ID_OFFSET = 20

// MINIDUMP_EXCEPTION_STREAM: ThreadId u32, __alignment u32, the 152-byte
// MINIDUMP_EXCEPTION, then the crashing thread's context location descriptor.
const THREAD_CONTEXT_OFFSET = 160

// Breakpad/Crashpad number every POSIX OS from MD_OS_UNIX (0x8000) up; Windows
// keeps the low VER_PLATFORM_* ids.
const PLATFORM_ID_POSIX_MIN = 0x8000
const PLATFORM_ID_WINDOWS_MAX = 3

const CPU_ARCHITECTURE_X86 = 0
const CPU_ARCHITECTURE_AMD64 = 9
const CPU_ARCHITECTURE_ARM64 = 12

// CONTEXT.ContextFlags carries the CPU in its high bits; the low byte selects
// register groups.
const CONTEXT_CPU_MASK = 0xffffff00
const CONTEXT_CPU_X86 = 0x0001_0000
const CONTEXT_CPU_AMD64 = 0x0010_0000
const CONTEXT_CPU_ARM64 = 0x0040_0000

type ContextLayout = {
  /** CONTEXT_AMD64 puts ContextFlags after the six home-parameter slots. */
  readonly flagsOffset: number
  readonly cpu: number
  readonly ipOffset: number
  readonly ipBytes: 4 | 8
}

/** Where ContextFlags and the instruction pointer sit, per SYSTEM_INFO architecture. */
const CONTEXT_LAYOUTS = new Map<number, ContextLayout>([
  // CONTEXT_X86.Eip
  [CPU_ARCHITECTURE_X86, { flagsOffset: 0, cpu: CONTEXT_CPU_X86, ipOffset: 184, ipBytes: 4 }],
  // CONTEXT_AMD64.Rip
  [CPU_ARCHITECTURE_AMD64, { flagsOffset: 48, cpu: CONTEXT_CPU_AMD64, ipOffset: 248, ipBytes: 8 }],
  // MinidumpContextARM64.pc
  [CPU_ARCHITECTURE_ARM64, { flagsOffset: 0, cpu: CONTEXT_CPU_ARM64, ipOffset: 264, ipBytes: 8 }]
])

const NO_SYSTEM_INFO =
  'this dump carries no readable system info, so the thread context layout is unknown'
const NO_THREAD_CONTEXT = 'this dump records no thread context for the crashing thread'
const TRUNCATED_EXCEPTION_STREAM =
  "this dump's exception record is truncated before it reaches the thread context"
const TRUNCATED_THREAD_CONTEXT = "the crashing thread's context is truncated in this dump"
// Reasons are paired at the call site and the whole string must survive the
// 240-character detail cap, so each half stays short enough to read intact.
const CONTEXT_ARCHITECTURE_MISMATCH =
  'the stored thread context does not identify itself as the CPU architecture this dump names'
const NULL_INSTRUCTION_POINTER = 'the stored instruction pointer is zero'
const POSIX_ADDRESS_IS_DATA =
  "this dump's exception address is siginfo.si_addr — the faulting data address on POSIX, not the instruction pointer"
const UNIDENTIFIED_PLATFORM =
  'this dump does not say which OS it came from, so its exception address cannot be read as an instruction pointer'
const NO_EXCEPTION_RECORD = 'this dump records no exception, so nothing faulted at an address'
const UNREADABLE_EXCEPTION_ADDRESS = "this dump's exception address could not be read"
const NO_MODULE_LIST = 'this dump carries no module list'
const UNREADABLE_MODULE_LIST = "this dump's module list could not be read"
const NO_MODULES_LISTED = "this dump's module list is empty"

/** Which image the name points at, or that we could not tell. */
export type FaultingModuleIdentity = 'product-image' | 'separate-module' | 'unidentified'

export type FaultingModuleResolution =
  | {
      readonly state: 'resolved'
      readonly module: string
      readonly offset: string
      readonly identity: FaultingModuleIdentity
      readonly addressSource: 'instruction-pointer' | 'exception-address'
    }
  /** The dump cannot answer this on this platform, however completely it was read. */
  | { readonly state: 'not-applicable'; readonly reason: string }
  /** Something we needed was absent or unreadable. Never an absence claim. */
  | { readonly state: 'unknown'; readonly reason: string }

type ModuleRecord = {
  readonly base: bigint
  readonly size: number
  /** null when the dump's MINIDUMP_STRING for this module could not be read. */
  readonly name: string | null
}

/** Basename of a path recorded in a dump, which may use either separator. */
export function dumpPathBasename(recordedPath: string): string {
  const separator = Math.max(recordedPath.lastIndexOf('/'), recordedPath.lastIndexOf('\\'))
  return separator >= 0 ? recordedPath.slice(separator + 1) : recordedPath
}

/**
 * Basenames of the images Electron statically links Chromium into. On macOS
 * that is the framework — the .app executable and the helpers are stubs — and
 * on Windows/Linux it is the app executable itself.
 */
export function chromiumLinkedImageNames(
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform
): readonly string[] {
  if (platform === 'darwin') {
    return ['Electron Framework']
  }
  const executable = dumpPathBasename(execPath)
  return executable ? [executable] : []
}

/**
 * `complete` false means the list is present but was not read end to end, so it
 * cannot be cited as proof that an address belongs to no module.
 */
type ModuleList =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }
  | {
      readonly kind: 'read'
      readonly modules: ModuleRecord[]
      readonly complete: boolean
    }

function readModules(view: MinidumpView): ModuleList {
  const stream = findStream(view, STREAM_TYPE_MODULE_LIST)
  if (!stream) {
    return { kind: 'absent' }
  }
  const count = view.u32(stream.rva)
  if (count === null || count > MAX_MODULES) {
    return { kind: 'unreadable' }
  }
  const modules: ModuleRecord[] = []
  for (let index = 0; index < count; index += 1) {
    const record = stream.rva + 4 + index * MODULE_RECORD_SIZE
    const base = view.u64(record + MODULE_BASE_OFFSET)
    const size = view.u32(record + MODULE_SIZE_OFFSET)
    const nameRva = view.u32(record + MODULE_NAME_RVA_OFFSET)
    if (base === null || size === null || nameRva === null) {
      return { kind: 'read', modules, complete: false }
    }
    modules.push({ base, size, name: view.utf16String(nameRva, 2_048) })
  }
  return { kind: 'read', modules, complete: true }
}

function readSystemInfo(view: MinidumpView): { architecture: number; platformId: number } | null {
  const stream = findStream(view, STREAM_TYPE_SYSTEM_INFO)
  if (!stream) {
    return null
  }
  const architecture = view.u16(stream.rva + SYSTEM_INFO_ARCHITECTURE_OFFSET)
  const platformId = view.u32(stream.rva + SYSTEM_INFO_PLATFORM_ID_OFFSET)
  if (architecture === null || platformId === null) {
    return null
  }
  return { architecture, platformId }
}

type InstructionPointerRead =
  | { readonly value: bigint; readonly unreadable?: undefined }
  | { readonly value: null; readonly unreadable: string }

/**
 * Locates the crashing thread's CONTEXT. `MinidumpView.location` folds "the
 * descriptor says absent" into "the descriptor could not be read"; those are
 * different claims and only the first is evidence that no context was recorded.
 */
function readThreadContext(
  view: MinidumpView,
  exception: LocationDescriptor
):
  | { readonly context: LocationDescriptor; readonly unreadable?: undefined }
  | { readonly context: null; readonly unreadable: string } {
  // The stream must actually reach its context descriptor: bytes past a short
  // stream are still inside the dump, so bounds-checking alone would read them.
  if (exception.size < THREAD_CONTEXT_OFFSET + 8) {
    return { context: null, unreadable: TRUNCATED_EXCEPTION_STREAM }
  }
  const at = exception.rva + THREAD_CONTEXT_OFFSET
  const size = view.u32(at)
  const rva = view.u32(at + 4)
  if (size === null || rva === null) {
    return { context: null, unreadable: TRUNCATED_EXCEPTION_STREAM }
  }
  if (rva === 0) {
    return { context: null, unreadable: NO_THREAD_CONTEXT }
  }
  return rva >= view.byteLength
    ? { context: null, unreadable: TRUNCATED_THREAD_CONTEXT }
    : { context: { size, rva } }
}

/**
 * The layout is picked from SYSTEM_INFO but confirmed against the context's own
 * ContextFlags: SYSTEM_INFO describes the machine, ContextFlags describes the
 * bytes actually stored, and on a disagreement the pointer would be read out of
 * the wrong struct and believed. Flags that cannot be read are a mismatch, not a
 * pass — an unconfirmed layout is exactly the confident wrong answer to avoid.
 */
function readInstructionPointer(
  view: MinidumpView,
  exception: LocationDescriptor,
  architecture: number | undefined
): InstructionPointerRead {
  if (architecture === undefined) {
    return { value: null, unreadable: NO_SYSTEM_INFO }
  }
  const layout = CONTEXT_LAYOUTS.get(architecture)
  if (!layout) {
    return {
      value: null,
      unreadable: `this dump's CPU architecture (${architecture}) has no thread context layout this build can read`
    }
  }
  const located = readThreadContext(view, exception)
  if (located.context === null) {
    return { value: null, unreadable: located.unreadable }
  }
  const context = located.context
  if (context.size < Math.max(layout.flagsOffset + 4, layout.ipOffset + layout.ipBytes)) {
    return { value: null, unreadable: TRUNCATED_THREAD_CONTEXT }
  }
  const flags = view.u32(context.rva + layout.flagsOffset)
  if (flags === null || (flags & CONTEXT_CPU_MASK) !== layout.cpu) {
    return { value: null, unreadable: CONTEXT_ARCHITECTURE_MISMATCH }
  }
  const at = context.rva + layout.ipOffset
  const raw = layout.ipBytes === 4 ? view.u32(at) : view.u64(at)
  if (raw === null) {
    return { value: null, unreadable: TRUNCATED_THREAD_CONTEXT }
  }
  const value = BigInt(raw)
  return value === 0n ? { value: null, unreadable: NULL_INSTRUCTION_POINTER } : { value }
}

/** Identity by recorded name only: index and image size both misname the product. */
function classifyIdentity(
  moduleName: string,
  productImageNames: readonly string[]
): FaultingModuleIdentity {
  if (productImageNames.length === 0) {
    return 'unidentified'
  }
  // Windows paths are case-insensitive and the dump records the on-disk spelling.
  const lowered = moduleName.toLowerCase()
  return productImageNames.some((name) => name.toLowerCase() === lowered)
    ? 'product-image'
    : 'separate-module'
}

function locateModule(
  view: MinidumpView,
  address: bigint,
  addressSource: 'instruction-pointer' | 'exception-address',
  productImageNames: readonly string[]
): FaultingModuleResolution {
  const list = readModules(view)
  if (list.kind !== 'read') {
    return {
      state: 'unknown',
      reason: list.kind === 'absent' ? NO_MODULE_LIST : UNREADABLE_MODULE_LIST
    }
  }
  if (list.modules.length === 0) {
    return {
      state: 'unknown',
      reason: list.complete ? NO_MODULES_LISTED : UNREADABLE_MODULE_LIST
    }
  }
  const label =
    addressSource === 'instruction-pointer' ? 'instruction pointer' : 'exception address'
  const at = `${label} 0x${address.toString(16)}`
  for (const module of list.modules) {
    if (address < module.base || address >= module.base + BigInt(module.size)) {
      continue
    }
    // An offset without a name localizes nothing, so an unnamed hit is reported
    // as unknown with its image base rather than as a module called "unknown".
    const name = module.name === null ? '' : dumpPathBasename(module.name)
    if (!name) {
      return {
        state: 'unknown',
        reason: `${at} falls inside a module this dump does not name (image base 0x${module.base.toString(16)})`
      }
    }
    return {
      state: 'resolved',
      module: name,
      offset: `0x${(address - module.base).toString(16)}`,
      identity: classifyIdentity(name, productImageNames),
      addressSource
    }
  }
  return {
    state: 'unknown',
    reason: list.complete
      ? `${at} is outside every loaded module`
      : `${at} is outside every module that could be read, and this dump's module list is truncated`
  }
}

type DumpPlatform = 'posix' | 'windows' | 'unidentified'

function classifyPlatform(platformId: number | undefined): DumpPlatform {
  if (platformId === undefined) {
    return 'unidentified'
  }
  if (platformId >= PLATFORM_ID_POSIX_MIN) {
    return 'posix'
  }
  return platformId <= PLATFORM_ID_WINDOWS_MAX ? 'windows' : 'unidentified'
}

/**
 * Resolves the module covering the crashing instruction, or states why it
 * cannot be named. Callers must publish the non-resolved states: omitting the
 * field reads as "no module was involved", a claim the dump never made.
 */
export function resolveFaultingModule(
  view: MinidumpView,
  exception: LocationDescriptor | null,
  exceptionAddress: bigint | null,
  productImageNames: readonly string[]
): FaultingModuleResolution {
  if (!exception) {
    return { state: 'not-applicable', reason: NO_EXCEPTION_RECORD }
  }
  const systemInfo = readSystemInfo(view)
  const platform = classifyPlatform(systemInfo?.platformId)
  // Windows documents ExceptionAddress as the address the exception occurred at,
  // which is the instruction — including the RaiseException site in KERNELBASE.
  if (platform === 'windows') {
    return exceptionAddress === null
      ? { state: 'unknown', reason: UNREADABLE_EXCEPTION_ADDRESS }
      : locateModule(view, exceptionAddress, 'exception-address', productImageNames)
  }
  const read = readInstructionPointer(view, exception, systemInfo?.architecture)
  if (read.value !== null) {
    return locateModule(view, read.value, 'instruction-pointer', productImageNames)
  }
  // Never fall back to the exception address here: on POSIX it is a data address,
  // and on an unidentified platform we cannot show that it is not.
  return platform === 'posix'
    ? {
        state: 'not-applicable',
        reason: `${read.unreadable}, and ${POSIX_ADDRESS_IS_DATA}`
      }
    : {
        state: 'unknown',
        reason: `${read.unreadable}; ${UNIDENTIFIED_PLATFORM}`
      }
}
