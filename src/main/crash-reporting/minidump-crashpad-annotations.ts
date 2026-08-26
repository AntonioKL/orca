// Reads Chromium's crash keys out of a Crashpad minidump's annotation streams.
//
// Some Chromium builds expose the fatal log line as `LOG_FATAL`; the signature
// parser also handles builds that carry it only in captured process memory.
// Layouts are from Crashpad's minidump_extensions.h.

import {
  findStream,
  MAX_MODULES,
  type LocationDescriptor,
  type LocationRead,
  type MinidumpView
} from './minidump-stream-reader'

// Why: a dump claiming an absurd annotation count is corrupt; cap before iterating.
const MAX_ANNOTATIONS = 512

const STREAM_TYPE_CRASHPAD_INFO = 0x43500001

const CRASHPAD_INFO_MIN_SIZE = 52
const CRASHPAD_INFO_SIMPLE_ANNOTATIONS_OFFSET = 36
const CRASHPAD_INFO_MODULE_LIST_OFFSET = 44

const MODULE_CRASHPAD_INFO_LINK_SIZE = 12
const MODULE_CRASHPAD_INFO_MIN_SIZE = 28
// list_annotations at +4 is a keyless legacy RVA list; nothing we can attribute.
const MODULE_CRASHPAD_INFO_SIMPLE_ANNOTATIONS_OFFSET = 12
const MODULE_CRASHPAD_INFO_ANNOTATION_OBJECTS_OFFSET = 20

const ANNOTATION_RECORD_SIZE = 12
const ANNOTATION_TYPE_STRING = 1

/**
 * Crashpad annotations we copy into a crash report.
 *
 * Why an allowlist: annotations are an open key space and some Chromium keys
 * (`switch-N`, extension ids) carry command lines and user data. Diagnostic
 * value here is concentrated in a handful of keys, so default-deny.
 */
const ANNOTATION_ALLOWLIST = new Set([
  // The whole point of this module — Chromium's fatal log line.
  'LOG_FATAL',
  'abort-message',
  // Which process died, independent of what Electron told us.
  'ptype',
  'ver',
  'prod',
  'plat',
  'osarch',
  'channel',
  // Distinguishes a one-off from a crash loop.
  'crash-loop-before',
  'first-crash-time',
  // The Linux SIGBUS/SIGSEGV reports are GPU-adjacent; driver identity matters.
  'gpu-gl-vendor',
  'gpu-gl-renderer',
  'gpu-driver-version',
  'gpu-vendor-id',
  'gpu-device-id',
  'gpu-generation-intel'
])

/**
 * MinidumpSimpleStringDictionary: u32 count, then {key rva, value rva} pairs.
 * Returns false when any entry went unread, since an unread key could be `ptype`.
 */
function readSimpleAnnotations(
  view: MinidumpView,
  read: LocationRead,
  into: Record<string, string>
): boolean {
  if (read.status !== 'present') {
    return read.status === 'absent'
  }
  const location = read.location
  const count = view.u32(location.rva)
  if (count === null || count > MAX_ANNOTATIONS || 4 + count * 8 > location.size) {
    return false
  }
  let allEntriesRead = true
  for (let index = 0; index < count; index += 1) {
    const entry = location.rva + 4 + index * 8
    const keyRva = view.u32(entry)
    const valueRva = view.u32(entry + 4)
    if (keyRva === null || valueRva === null) {
      return false
    }
    const key = view.utf8String(keyRva, 256)
    if (key === null) {
      allEntriesRead = false
      continue
    }
    if (!ANNOTATION_ALLOWLIST.has(key)) {
      continue
    }
    const value = view.utf8String(valueRva)
    if (value === null) {
      allEntriesRead = false
      continue
    }
    into[key] = value
  }
  return allEntriesRead
}

/**
 * MinidumpAnnotationList: u32 count, then MinidumpAnnotation records. Returns
 * false when any record went unread, since an unread name could be `ptype`.
 */
function readAnnotationObjects(
  view: MinidumpView,
  read: LocationRead,
  into: Record<string, string>
): boolean {
  if (read.status !== 'present') {
    return read.status === 'absent'
  }
  const location = read.location
  const count = view.u32(location.rva)
  if (
    count === null ||
    count > MAX_ANNOTATIONS ||
    4 + count * ANNOTATION_RECORD_SIZE > location.size
  ) {
    return false
  }
  let allRecordsRead = true
  for (let index = 0; index < count; index += 1) {
    const entry = location.rva + 4 + index * ANNOTATION_RECORD_SIZE
    const nameRva = view.u32(entry)
    const type = view.u16(entry + 4)
    const valueRva = view.u32(entry + 8)
    if (nameRva === null || type === null || valueRva === null) {
      return false
    }
    if (type !== ANNOTATION_TYPE_STRING || valueRva === 0) {
      continue
    }
    const name = view.utf8String(nameRva, 256)
    if (name === null) {
      allRecordsRead = false
      continue
    }
    if (!ANNOTATION_ALLOWLIST.has(name)) {
      continue
    }
    const raw = view.byteArray(valueRva)
    if (!raw) {
      allRecordsRead = false
      continue
    }
    // Annotation strings are not NUL-terminated; trim a trailing one anyway.
    let value = raw.toString('utf8')
    while (value.endsWith('\0')) {
      value = value.slice(0, -1)
    }
    into[name] = value
  }
  return allRecordsRead
}

export type CrashpadAnnotationRead = {
  readonly annotations: Record<string, string>
  /**
   * False when any part of the annotation walk went unread: the CrashpadInfo
   * stream, the module-link list, a link's info record, or a single annotation
   * entry. What came back is then partial, so a key missing from it — `ptype`
   * above all — is undetermined rather than absent.
   */
  readonly annotationsComplete: boolean
}

/**
 * Walks the links, returning false if any link's MinidumpModuleCrashpadInfo went
 * unread. Chromium attaches `ptype`/`LOG_FATAL` to exactly one module, so a
 * single skipped link can be the one that carried them.
 */
function readModuleLinks(
  view: MinidumpView,
  moduleList: LocationDescriptor,
  linkCount: number,
  annotations: Record<string, string>
): boolean {
  let allLinksRead = true
  for (let index = 0; index < linkCount; index += 1) {
    const link = moduleList.rva + 4 + index * MODULE_CRASHPAD_INFO_LINK_SIZE
    const moduleInfo = view.locationRead(link + 4)
    if (moduleInfo.status === 'absent') {
      continue
    }
    if (
      moduleInfo.status === 'unreadable' ||
      moduleInfo.location.size < MODULE_CRASHPAD_INFO_MIN_SIZE
    ) {
      allLinksRead = false
      continue
    }
    // Why: Chromium's crash keys land in annotation_objects on current
    // Crashpad, but older modules still populate the two legacy shapes.
    const simpleRead = readSimpleAnnotations(
      view,
      view.locationRead(moduleInfo.location.rva + MODULE_CRASHPAD_INFO_SIMPLE_ANNOTATIONS_OFFSET),
      annotations
    )
    const objectsRead = readAnnotationObjects(
      view,
      view.locationRead(moduleInfo.location.rva + MODULE_CRASHPAD_INFO_ANNOTATION_OBJECTS_OFFSET),
      annotations
    )
    allLinksRead = allLinksRead && simpleRead && objectsRead
  }
  return allLinksRead
}

export function readCrashpadAnnotations(view: MinidumpView): CrashpadAnnotationRead {
  const annotations: Record<string, string> = {}
  const info = findStream(view, STREAM_TYPE_CRASHPAD_INFO)
  if (!info) {
    return { annotations, annotationsComplete: true }
  }
  // A stream too short to reach module_list never said the list was empty.
  if (info.size < CRASHPAD_INFO_MIN_SIZE) {
    return { annotations, annotationsComplete: false }
  }

  const processLevelRead = readSimpleAnnotations(
    view,
    view.locationRead(info.rva + CRASHPAD_INFO_SIMPLE_ANNOTATIONS_OFFSET),
    annotations
  )

  const moduleList = view.locationRead(info.rva + CRASHPAD_INFO_MODULE_LIST_OFFSET)
  if (moduleList.status !== 'present') {
    return {
      annotations,
      annotationsComplete: processLevelRead && moduleList.status === 'absent'
    }
  }
  const moduleCount = view.u32(moduleList.location.rva)
  if (moduleCount === null) {
    return { annotations, annotationsComplete: false }
  }
  // Why clamp rather than bail: links past the declared list are unrelated dump
  // bytes that would fabricate a LOG_FATAL headline, but the links the size does
  // hold are still real, and dropping them loses the annotations we came for.
  const declaredLinks = Math.floor((moduleList.location.size - 4) / MODULE_CRASHPAD_INFO_LINK_SIZE)
  const readableLinks = Math.max(0, Math.min(moduleCount, MAX_MODULES, declaredLinks))
  const allLinksRead = readModuleLinks(view, moduleList.location, readableLinks, annotations)
  return {
    annotations,
    annotationsComplete: processLevelRead && allLinksRead && readableLinks >= moduleCount
  }
}
