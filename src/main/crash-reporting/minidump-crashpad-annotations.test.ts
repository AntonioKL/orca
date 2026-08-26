import { describe, expect, it } from 'vitest'
import { readCrashpadAnnotations } from './minidump-crashpad-annotations'
import { MinidumpView } from './minidump-stream-reader'

const STREAM_TYPE_CRASHPAD_INFO = 0x43500001
const CRASHPAD_INFO_SIZE = 52
const LINK_SIZE = 12
const MODULE_INFO_SIZE = 28

const FATAL_LINE = '[0101/000000.000000:FATAL:fabricated.cc(9)] Check failed: fabricated.'

function utf8String(value: string): Buffer {
  const data = Buffer.from(value, 'utf8')
  const buf = Buffer.alloc(4 + data.length + 1)
  buf.writeUInt32LE(data.length, 0)
  data.copy(buf, 4)
  return buf
}

function location(size: number, rva: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeUInt32LE(size, 0)
  buf.writeUInt32LE(rva, 4)
  return buf
}

/**
 * Crashpad info stream whose module-link list carries `writtenLinks` links, the
 * last of which points at a `LOG_FATAL` + `ptype` module info and the rest at
 * nothing, under a caller-chosen count and declared list size — the two a
 * corrupt dump can disagree on.
 */
function buildCrashpadDump(options: {
  declaredLinkCount: number
  declaredListSize: number
  writtenLinks?: number
  /** Overrides the RVA the CrashpadInfo stream points the link list at. */
  moduleListRva?: number
  /** Overrides the stream size the directory declares for CrashpadInfo. */
  declaredStreamSize?: number
  /** Overrides the carrier link's declared MinidumpModuleCrashpadInfo size/RVA. */
  carrierInfoSize?: number
  carrierInfoRva?: number
  /** Overrides the size the carrier's simple-annotation dictionary declares. */
  declaredDictionarySize?: number
  /** Points the LOG_FATAL key string past the end of the dump. */
  unreadableFatalKey?: boolean
}): Buffer {
  const writtenLinks = options.writtenLinks ?? 2
  const prefix = 32 + 12
  const regions: Buffer[] = []
  let cursor = prefix
  const append = (buf: Buffer): number => {
    const rva = cursor
    regions.push(buf)
    cursor += buf.length
    return rva
  }

  const entries: [string, string][] = [
    ['LOG_FATAL', FATAL_LINE],
    ['ptype', 'renderer']
  ]
  const pairs = entries.map(([key, value]) => ({
    keyRva:
      key === 'LOG_FATAL' && options.unreadableFatalKey ? 0xffff_0000 : append(utf8String(key)),
    valueRva: append(utf8String(value))
  }))
  const dictionary = Buffer.alloc(4 + pairs.length * 8)
  dictionary.writeUInt32LE(pairs.length, 0)
  pairs.forEach((pair, index) => {
    dictionary.writeUInt32LE(pair.keyRva, 4 + index * 8)
    dictionary.writeUInt32LE(pair.valueRva, 8 + index * 8)
  })
  const dictionaryRva = append(dictionary)

  // MinidumpModuleCrashpadInfo: version, list_annotations, simple_annotations, objects.
  const moduleInfo = Buffer.concat([
    (() => {
      const version = Buffer.alloc(4)
      version.writeUInt32LE(1, 0)
      return version
    })(),
    location(0, 0),
    location(options.declaredDictionarySize ?? dictionary.length, dictionaryRva),
    location(0, 0)
  ])
  expect(moduleInfo.length).toBe(MODULE_INFO_SIZE)
  const moduleInfoRva = append(moduleInfo)

  const links = Buffer.alloc(4 + writtenLinks * LINK_SIZE)
  links.writeUInt32LE(options.declaredLinkCount, 0)
  for (let index = 0; index < writtenLinks; index += 1) {
    const at = 4 + index * LINK_SIZE
    links.writeUInt32LE(index, at) // minidump module index
    if (index === writtenLinks - 1) {
      links.writeUInt32LE(options.carrierInfoSize ?? moduleInfo.length, at + 4)
      links.writeUInt32LE(options.carrierInfoRva ?? moduleInfoRva, at + 8)
    }
  }
  const linksRva = append(links)

  const info = Buffer.concat([
    Buffer.alloc(4 + 16 + 16), // version, report id, client id
    location(0, 0), // process-level simple annotations
    location(options.declaredListSize, options.moduleListRva ?? linksRva)
  ])
  expect(info.length).toBe(CRASHPAD_INFO_SIZE)
  const infoRva = append(info)

  const header = Buffer.alloc(32)
  header.writeUInt32LE(0x504d444d, 0)
  header.writeUInt32LE(0xa793, 4)
  header.writeUInt32LE(1, 8)
  header.writeUInt32LE(32, 12)
  const directory = Buffer.alloc(12)
  directory.writeUInt32LE(STREAM_TYPE_CRASHPAD_INFO, 0)
  directory.writeUInt32LE(options.declaredStreamSize ?? info.length, 4)
  directory.writeUInt32LE(infoRva, 8)

  return Buffer.concat([header, directory, ...regions])
}

describe('readCrashpadAnnotations module link list', () => {
  it('reads annotations from every link the list declares', () => {
    const dump = buildCrashpadDump({
      declaredLinkCount: 2,
      declaredListSize: 4 + 2 * LINK_SIZE
    })

    const { annotations, annotationsComplete } = readCrashpadAnnotations(new MinidumpView(dump))

    expect(annotations.LOG_FATAL).toBe(FATAL_LINE)
    expect(annotationsComplete).toBe(true)
  })

  it('reports a link count the declared list size cannot hold as unread, not empty', () => {
    const dump = buildCrashpadDump({
      // Room for one link, but the count reaches into whatever follows.
      declaredLinkCount: 2_000,
      declaredListSize: 4 + LINK_SIZE
    })

    const { annotations, annotationsComplete } = readCrashpadAnnotations(new MinidumpView(dump))

    expect(annotations.LOG_FATAL).toBeUndefined()
    expect(annotationsComplete).toBe(false)
  })

  it('reads the links the declared size does hold under an over-declared count', () => {
    const dump = buildCrashpadDump({
      // Count reaches past the list, but both real links are inside the size.
      declaredLinkCount: 2,
      declaredListSize: 4 + 2 * LINK_SIZE,
      writtenLinks: 2
    })

    const { annotations, annotationsComplete } = readCrashpadAnnotations(new MinidumpView(dump))

    expect(annotations.LOG_FATAL).toBe(FATAL_LINE)
    expect(annotationsComplete).toBe(true)
  })

  it('reports the list as unread when the carrier link sits past the declared size', () => {
    const dump = buildCrashpadDump({
      declaredLinkCount: 3,
      declaredListSize: 4 + LINK_SIZE,
      writtenLinks: 3
    })

    const { annotations, annotationsComplete } = readCrashpadAnnotations(new MinidumpView(dump))

    expect(annotations.ptype).toBeUndefined()
    expect(annotationsComplete).toBe(false)
  })

  it('reports a module-link list pointed past the end of the dump as unread', () => {
    const dump = buildCrashpadDump({
      declaredLinkCount: 2,
      declaredListSize: 4 + 2 * LINK_SIZE,
      moduleListRva: 0xffff_0000
    })

    const { annotations, annotationsComplete } = readCrashpadAnnotations(new MinidumpView(dump))

    expect(annotations.ptype).toBeUndefined()
    expect(annotationsComplete).toBe(false)
  })

  it('reports a CrashpadInfo stream too short to carry the list descriptor as unread', () => {
    const dump = buildCrashpadDump({
      declaredLinkCount: 2,
      declaredListSize: 4 + 2 * LINK_SIZE,
      declaredStreamSize: 40
    })

    const { annotations, annotationsComplete } = readCrashpadAnnotations(new MinidumpView(dump))

    expect(annotations.ptype).toBeUndefined()
    expect(annotationsComplete).toBe(false)
  })

  it('reports a link whose module info sits past the end of the dump as unread', () => {
    const dump = buildCrashpadDump({
      declaredLinkCount: 2,
      declaredListSize: 4 + 2 * LINK_SIZE,
      carrierInfoRva: 0xffff_0000
    })

    const { annotations, annotationsComplete } = readCrashpadAnnotations(new MinidumpView(dump))

    expect(annotations.ptype).toBeUndefined()
    expect(annotationsComplete).toBe(false)
  })

  it('reports a link whose module info is under the minimum size as unread', () => {
    const dump = buildCrashpadDump({
      declaredLinkCount: 2,
      declaredListSize: 4 + 2 * LINK_SIZE,
      carrierInfoSize: MODULE_INFO_SIZE - 8
    })

    const { annotations, annotationsComplete } = readCrashpadAnnotations(new MinidumpView(dump))

    expect(annotations.ptype).toBeUndefined()
    expect(annotationsComplete).toBe(false)
  })

  it('keeps a link the producer marked absent from making the list unread', () => {
    // Every link but the carrier has a zero RVA: "this module has no info", read.
    const dump = buildCrashpadDump({
      declaredLinkCount: 4,
      declaredListSize: 4 + 4 * LINK_SIZE,
      writtenLinks: 4
    })

    const { annotations, annotationsComplete } = readCrashpadAnnotations(new MinidumpView(dump))

    expect(annotations.ptype).toBe('renderer')
    expect(annotationsComplete).toBe(true)
  })
  it('reports a dictionary whose count overruns its declared size as unread', () => {
    const dump = buildCrashpadDump({
      declaredLinkCount: 2,
      declaredListSize: 4 + 2 * LINK_SIZE,
      declaredDictionarySize: 8
    })

    const { annotations, annotationsComplete } = readCrashpadAnnotations(new MinidumpView(dump))

    expect(annotations.ptype).toBeUndefined()
    expect(annotationsComplete).toBe(false)
  })

  it('reports an annotation key pointed past the end of the dump as unread', () => {
    const dump = buildCrashpadDump({
      declaredLinkCount: 2,
      declaredListSize: 4 + 2 * LINK_SIZE,
      unreadableFatalKey: true
    })

    const { annotations, annotationsComplete } = readCrashpadAnnotations(new MinidumpView(dump))

    // The entry after it still reads; one unreadable key is not an empty list.
    expect(annotations.LOG_FATAL).toBeUndefined()
    expect(annotations.ptype).toBe('renderer')
    expect(annotationsComplete).toBe(false)
  })
})
