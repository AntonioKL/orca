import { describe, expect, it } from 'vitest'
import { minidumpSignatureDetails, parseMinidumpCrashSignature } from './minidump-crash-signature'
import { MAX_MODULES } from './minidump-stream-reader'

const STREAM_TYPE_MODULE_LIST = 4
const STREAM_TYPE_EXCEPTION = 6
const STREAM_TYPE_CRASHPAD_INFO = 0x43500001

/**
 * Builds real Crashpad-layout minidumps so the parser is tested against the
 * byte format rather than a mock. Regions are appended and referenced by RVA,
 * matching how Crashpad emits them.
 */
class MinidumpBuilder {
  private regions: Buffer[] = []
  private cursor = 0

  constructor(private readonly headerAndDirectoryBytes: number) {
    this.cursor = headerAndDirectoryBytes
  }

  append(buf: Buffer): number {
    const rva = this.cursor
    this.regions.push(buf)
    this.cursor += buf.length
    return rva
  }

  utf8String(value: string): number {
    const data = Buffer.from(value, 'utf8')
    const buf = Buffer.alloc(4 + data.length + 1)
    buf.writeUInt32LE(data.length, 0)
    data.copy(buf, 4)
    return this.append(buf)
  }

  utf16String(value: string): number {
    const data = Buffer.from(value, 'utf16le')
    const buf = Buffer.alloc(4 + data.length + 2)
    buf.writeUInt32LE(data.length, 0)
    data.copy(buf, 4)
    return this.append(buf)
  }

  byteArray(value: string): number {
    const data = Buffer.from(value, 'utf8')
    const buf = Buffer.alloc(4 + data.length)
    buf.writeUInt32LE(data.length, 0)
    data.copy(buf, 4)
    return this.append(buf)
  }

  build(streams: { type: number; size: number; rva: number }[]): Buffer {
    const header = Buffer.alloc(32)
    header.writeUInt32LE(0x504d444d, 0)
    header.writeUInt32LE(0xa793, 4)
    header.writeUInt32LE(streams.length, 8)
    header.writeUInt32LE(32, 12)
    const directory = Buffer.alloc(streams.length * 12)
    streams.forEach((stream, index) => {
      directory.writeUInt32LE(stream.type, index * 12)
      directory.writeUInt32LE(stream.size, index * 12 + 4)
      directory.writeUInt32LE(stream.rva, index * 12 + 8)
    })
    const body = Buffer.concat(this.regions)
    const prefix = Buffer.concat([header, directory])
    expect(prefix.length).toBe(this.headerAndDirectoryBytes)
    return Buffer.concat([prefix, body])
  }
}

function location(size: number, rva: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeUInt32LE(size, 0)
  buf.writeUInt32LE(rva, 4)
  return buf
}

const EMPTY_LOCATION = location(0, 0)

// A name region Crashpad has not written yet: the record's RVA lands past EOF,
// which is what reading a dump mid-write looks like.
const UNWRITTEN_NAME_RVA = 0xffff_0000

type BuiltDump = { dump: Buffer }

/**
 * @param annotations key/value pairs written as MinidumpAnnotation objects
 *   hanging off a module's crashpad info, which is where Chromium crash keys
 *   (including LOG_FATAL) actually live.
 */
function buildDump(options: {
  annotations?: Record<string, string>
  simpleAnnotations?: Record<string, string>
  exception?: { code: number; address: bigint }
  /** `name: null` writes a record whose name region is missing from the dump. */
  modules?: { base: bigint; size: number; name: string | null }[]
  /** Declares more modules than the list carries, as a corrupt dump does. */
  declaredModuleCount?: number
  /** Stream-directory size for the module list, when it must disagree with the count. */
  moduleListDeclaredSize?: number
  /** Writes the 4-byte pad between NumberOfModules and Modules[0] that 64-bit ABIs emit. */
  moduleListPadded?: boolean
  /** Declared size of Crashpad's module-link list, when it must under-declare. */
  crashpadModuleLinkListSize?: number
}): BuiltDump {
  const streamCount =
    1 + (options.exception ? 1 : 0) + (options.modules && options.modules.length > 0 ? 1 : 0)
  const builder = new MinidumpBuilder(32 + streamCount * 12)
  const streams: { type: number; size: number; rva: number }[] = []

  // Module-level annotation objects.
  const annotationEntries = Object.entries(options.annotations ?? {})
  const annotationRecords = annotationEntries.map(([name, value]) => ({
    nameRva: builder.utf8String(name),
    valueRva: builder.byteArray(value)
  }))
  const annotationListBuf = Buffer.alloc(4 + annotationRecords.length * 12)
  annotationListBuf.writeUInt32LE(annotationRecords.length, 0)
  annotationRecords.forEach((record, index) => {
    const at = 4 + index * 12
    annotationListBuf.writeUInt32LE(record.nameRva, at)
    annotationListBuf.writeUInt16LE(1, at + 4) // kString
    annotationListBuf.writeUInt16LE(0, at + 6)
    annotationListBuf.writeUInt32LE(record.valueRva, at + 8)
  })
  const annotationListRva = builder.append(annotationListBuf)

  // Process-level simple string dictionary.
  const simpleEntries = Object.entries(options.simpleAnnotations ?? {})
  const simplePairs = simpleEntries.map(([key, value]) => ({
    keyRva: builder.utf8String(key),
    valueRva: builder.utf8String(value)
  }))
  const simpleBuf = Buffer.alloc(4 + simplePairs.length * 8)
  simpleBuf.writeUInt32LE(simplePairs.length, 0)
  simplePairs.forEach((pair, index) => {
    simpleBuf.writeUInt32LE(pair.keyRva, 4 + index * 8)
    simpleBuf.writeUInt32LE(pair.valueRva, 4 + index * 8 + 4)
  })
  const simpleRva = builder.append(simpleBuf)

  // MinidumpModuleCrashpadInfo (version, list_annotations, simple, objects).
  const moduleInfoBuf = Buffer.concat([
    (() => {
      const v = Buffer.alloc(4)
      v.writeUInt32LE(1, 0)
      return v
    })(),
    EMPTY_LOCATION,
    EMPTY_LOCATION,
    location(annotationListBuf.length, annotationListRva)
  ])
  const moduleInfoRva = builder.append(moduleInfoBuf)

  const moduleLinkBuf = Buffer.alloc(4 + 12)
  moduleLinkBuf.writeUInt32LE(1, 0)
  moduleLinkBuf.writeUInt32LE(0, 4) // minidump module index
  moduleLinkBuf.writeUInt32LE(moduleInfoBuf.length, 8)
  moduleLinkBuf.writeUInt32LE(moduleInfoRva, 12)
  const moduleLinkRva = builder.append(moduleLinkBuf)

  const crashpadInfoBuf = Buffer.concat([
    (() => {
      const v = Buffer.alloc(4 + 16 + 16)
      v.writeUInt32LE(1, 0)
      return v
    })(),
    location(simpleBuf.length, simpleRva),
    location(options.crashpadModuleLinkListSize ?? moduleLinkBuf.length, moduleLinkRva)
  ])
  const crashpadInfoRva = builder.append(crashpadInfoBuf)
  streams.push({
    type: STREAM_TYPE_CRASHPAD_INFO,
    size: crashpadInfoBuf.length,
    rva: crashpadInfoRva
  })

  if (options.modules && options.modules.length > 0) {
    const nameRvas = options.modules.map((module) =>
      module.name === null ? UNWRITTEN_NAME_RVA : builder.utf16String(module.name)
    )
    const recordsAt = options.moduleListPadded ? 8 : 4
    const listBuf = Buffer.alloc(recordsAt + options.modules.length * 108)
    listBuf.writeUInt32LE(options.declaredModuleCount ?? options.modules.length, 0)
    options.modules.forEach((module, index) => {
      const at = recordsAt + index * 108
      listBuf.writeBigUInt64LE(module.base, at)
      listBuf.writeUInt32LE(module.size, at + 8)
      listBuf.writeUInt32LE(nameRvas[index], at + 20)
    })
    streams.push({
      type: STREAM_TYPE_MODULE_LIST,
      size: options.moduleListDeclaredSize ?? listBuf.length,
      rva: builder.append(listBuf)
    })
  }

  if (options.exception) {
    const exceptionBuf = Buffer.alloc(168)
    exceptionBuf.writeUInt32LE(1234, 0) // ThreadId
    exceptionBuf.writeUInt32LE(options.exception.code, 8)
    exceptionBuf.writeBigUInt64LE(options.exception.address, 24)
    streams.push({
      type: STREAM_TYPE_EXCEPTION,
      size: exceptionBuf.length,
      rva: builder.append(exceptionBuf)
    })
  }

  return { dump: builder.build(streams) }
}

const FATAL_LINE =
  '[8104:1234:0815/143022.123456:FATAL:render_frame_impl.cc(4821)] Check failed: !is_detached_.'

const ELECTRON_43_CHECK_LINE =
  '[29136:0815/232206.330:ERROR:third_party\\blink\\common\\chrome_debug_urls.cc:180] Intentionally causing CHECK because user navigated to chrome://checkcrash/'

describe('parseMinidumpCrashSignature', () => {
  it('names the failing CHECK from the LOG_FATAL annotation', () => {
    const { dump } = buildDump({
      annotations: { LOG_FATAL: FATAL_LINE, ptype: 'renderer' }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.checkMessage).toBe(FATAL_LINE)
    expect(signature?.checkFile).toBe('render_frame_impl.cc')
    expect(signature?.checkLine).toBe(4821)
    expect(signature?.processType).toBe('renderer')
  })

  it('keeps parsing when an unread annotation list left the process type unknown', () => {
    const { dump } = buildDump({
      annotations: { LOG_FATAL: FATAL_LINE, ptype: 'renderer' },
      // Room for zero links, so the carrier the count declares is never reached.
      crashpadModuleLinkListSize: 4
    })

    const signature = parseMinidumpCrashSignature(dump, { expectedProcessType: 'renderer' })

    expect(signature?.processType).toBeUndefined()
    expect(signature?.annotationListStatus).toBe('unreadable')
    expect(signature?.checkMessage).toContain('Check failed: !is_detached_.')
  })

  it('recovers a CHECK line from Electron 43 dump memory without LOG_FATAL', () => {
    const { dump } = buildDump({ annotations: { ptype: 'renderer' } })
    const dumpWithMemory = Buffer.concat([
      dump,
      Buffer.from(`\0${ELECTRON_43_CHECK_LINE}\0`, 'utf8')
    ])

    const signature = parseMinidumpCrashSignature(dumpWithMemory)

    expect(signature?.checkMessage).toBe(ELECTRON_43_CHECK_LINE)
    expect(signature?.checkFile).toBe('chrome_debug_urls.cc')
    expect(signature?.checkLine).toBe(180)
    expect(signature?.processType).toBe('renderer')
  })

  it('stops at the process type when the dump belongs to another process', () => {
    const { dump } = buildDump({ annotations: { ptype: 'gpu-process' } })
    const dumpWithMemory = Buffer.concat([
      dump,
      Buffer.from(`\0${ELECTRON_43_CHECK_LINE}\0`, 'utf8')
    ])

    const signature = parseMinidumpCrashSignature(dumpWithMemory, {
      expectedProcessType: 'renderer'
    })

    expect(signature?.processType).toBe('gpu-process')
    // The whole-buffer scan is skipped; the caller discards this dump anyway.
    expect(signature?.checkMessage).toBeUndefined()
  })

  it('still parses fully when the process type matches', () => {
    const { dump } = buildDump({ annotations: { ptype: 'renderer' } })
    const dumpWithMemory = Buffer.concat([
      dump,
      Buffer.from(`\0${ELECTRON_43_CHECK_LINE}\0`, 'utf8')
    ])

    const signature = parseMinidumpCrashSignature(dumpWithMemory, {
      expectedProcessType: 'renderer'
    })

    expect(signature?.checkMessage).toBe(ELECTRON_43_CHECK_LINE)
  })

  it('ignores a log prefix further back than the prefix limit', () => {
    const { dump } = buildDump({ annotations: { ptype: 'renderer' } })
    // `[` separated from the marker by more than MAX_LOG_PREFIX_BYTES (96).
    const farPrefix = `[${'x'.repeat(200)}:FATAL:render_frame_impl.cc(4821)] Check failed: far.`
    const dumpWithMemory = Buffer.concat([dump, Buffer.from(`\0${farPrefix}\0`, 'utf8')])

    expect(parseMinidumpCrashSignature(dumpWithMemory)?.checkMessage).toBeUndefined()
  })

  it('does not promote an unrelated Chromium ERROR line containing CHECK', () => {
    const { dump } = buildDump({})
    const unrelated =
      '[29136:0815/232206.330:ERROR:settings.cc:44] Opened the CHECK settings panel.'
    const dumpWithMemory = Buffer.concat([dump, Buffer.from(`\0${unrelated}\0`, 'utf8')])

    expect(parseMinidumpCrashSignature(dumpWithMemory)?.checkMessage).toBeUndefined()
  })

  it('prefers the structured annotation over a dump-memory candidate', () => {
    const { dump } = buildDump({ annotations: { LOG_FATAL: FATAL_LINE } })
    const dumpWithMemory = Buffer.concat([
      dump,
      Buffer.from(`\0${ELECTRON_43_CHECK_LINE}\0`, 'utf8')
    ])

    expect(parseMinidumpCrashSignature(dumpWithMemory)?.checkMessage).toBe(FATAL_LINE)
  })

  it('reads annotations from the process-level simple string dictionary', () => {
    const { dump } = buildDump({
      simpleAnnotations: {
        ptype: 'gpu-process',
        'gpu-gl-vendor': 'Intel Inc.'
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.processType).toBe('gpu-process')
    expect(signature?.annotations['gpu-gl-vendor']).toBe('Intel Inc.')
  })

  it('drops annotations outside the allowlist', () => {
    const { dump } = buildDump({
      annotations: {
        LOG_FATAL: FATAL_LINE,
        'switch-3': '--user-data-dir=/Users/someone/secret'
      }
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.annotations['switch-3']).toBeUndefined()
    expect(Object.keys(signature?.annotations ?? {})).toEqual(['LOG_FATAL'])
  })

  it('resolves the faulting module from the exception address', () => {
    const { dump } = buildDump({
      exception: { code: 0x80000003, address: 0x7ff8_0000_1234n },
      modules: [
        {
          base: 0x7ff7_0000_0000n,
          size: 0x1000,
          name: 'C:\\Program Files\\Orca\\Orca.exe'
        },
        {
          base: 0x7ff8_0000_0000n,
          size: 0x10_0000,
          name: 'C:\\Program Files\\Orca\\chrome_elf.dll'
        }
      ]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.exceptionCode).toBe(0x80000003)
    expect(signature?.exceptionAddress).toBe('0x7ff800001234')
    expect(signature?.faultingModule).toBe('chrome_elf.dll')
    expect(signature?.faultingModuleOffset).toBe('0x1234')
  })

  it('omits the faulting module when no image range covers the address', () => {
    const { dump } = buildDump({
      exception: { code: 11, address: 0x10n },
      modules: [{ base: 0x7ff7_0000_0000n, size: 0x1000, name: '/opt/orca/orca' }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.exceptionAddress).toBe('0x10')
    expect(signature?.faultingModule).toBeUndefined()
  })

  it('returns null for a buffer that is not a minidump', () => {
    expect(parseMinidumpCrashSignature(Buffer.from('not a dump at all', 'utf8'))).toBeNull()
    expect(parseMinidumpCrashSignature(Buffer.alloc(0))).toBeNull()
  })

  it('degrades instead of throwing on a truncated dump', () => {
    const { dump } = buildDump({ annotations: { LOG_FATAL: FATAL_LINE } })

    const truncated = dump.subarray(0, 48)

    expect(() => parseMinidumpCrashSignature(truncated)).not.toThrow()
    expect(parseMinidumpCrashSignature(truncated)?.checkMessage).toBeUndefined()
  })

  it('degrades instead of throwing when stream counts are corrupt', () => {
    const { dump } = buildDump({ annotations: { LOG_FATAL: FATAL_LINE } })
    const corrupt = Buffer.from(dump)
    corrupt.writeUInt32LE(0xffff_ffff, 8)

    expect(() => parseMinidumpCrashSignature(corrupt)).not.toThrow()
    expect(parseMinidumpCrashSignature(corrupt)?.annotations).toEqual({})
  })
})

describe('minidumpSignatureDetails', () => {
  it('flattens the check location and faulting module into detail keys', () => {
    const { dump } = buildDump({
      annotations: {
        LOG_FATAL: FATAL_LINE,
        ptype: 'renderer',
        channel: 'stable'
      },
      exception: { code: 0x80000003, address: 0x7ff8_0000_1234n },
      modules: [{ base: 0x7ff8_0000_0000n, size: 0x10_0000, name: 'chrome_elf.dll' }]
    })

    const details = minidumpSignatureDetails(parseMinidumpCrashSignature(dump)!)

    expect(details).toMatchObject({
      minidumpCheckMessage: FATAL_LINE,
      minidumpCheckFile: 'render_frame_impl.cc',
      minidumpCheckLine: 4821,
      minidumpProcessType: 'renderer',
      minidumpExceptionCode: '0x80000003',
      minidumpFaultingModule: 'chrome_elf.dll',
      minidumpAnnotation_channel: 'stable'
    })
  })

  it('does not duplicate the fatal line into an annotation key', () => {
    const { dump } = buildDump({ annotations: { LOG_FATAL: FATAL_LINE } })

    const details = minidumpSignatureDetails(parseMinidumpCrashSignature(dump)!)

    expect(details.minidumpAnnotation_LOG_FATAL).toBeUndefined()
  })
})

describe('module list capacity', () => {
  /** Measured image count of a real macOS renderer; the cap must clear it. */
  const MACOS_RENDERER_IMAGE_COUNT = 1_042

  function manyModules(count: number): { base: bigint; size: number; name: string }[] {
    return Array.from({ length: count }, (_, index) => ({
      base: BigInt(0x1_0000_0000 + index * 0x1_0000),
      size: 0x1000,
      name: `/opt/orca/lib/module-${index}.dylib`
    }))
  }

  it('resolves the faulting module in a macOS renderer sized image list', () => {
    const modules = manyModules(MACOS_RENDERER_IMAGE_COUNT)
    const target = modules[MACOS_RENDERER_IMAGE_COUNT - 1]
    const { dump } = buildDump({
      exception: { code: 11, address: target.base + 0x24n },
      modules
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe(`module-${MACOS_RENDERER_IMAGE_COUNT - 1}.dylib`)
    expect(signature?.faultingModuleOffset).toBe('0x24')
    expect(signature?.moduleListStatus).toBeUndefined()
  })

  it('reports truncation as a distinct state instead of an absent faulting module', () => {
    const modules = manyModules(MAX_MODULES + 1)
    const target = modules[MAX_MODULES]
    const { dump } = buildDump({
      exception: { code: 11, address: target.base + 0x8n },
      modules
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.moduleListStatus).toBe('truncated')
    expect(signature?.faultingModule).toBeUndefined()
    expect(minidumpSignatureDetails(signature!).minidumpModuleListStatus).toBe('truncated')
  })

  it('reports an unreadable module list when records run past the end of the dump', () => {
    const { dump } = buildDump({
      exception: { code: 11, address: 0xdead_0000n },
      modules: manyModules(8),
      declaredModuleCount: 4_000,
      // The stream claims room the file cannot back, so only EOF can stop the walk.
      moduleListDeclaredSize: 4 + 4_000 * 108
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.moduleListStatus).toBe('unreadable')
    expect(signature?.faultingModule).toBeUndefined()
  })

  it('stops at the declared stream size instead of reading trailing bytes as modules', () => {
    const modules = [
      { base: 0x1000_0000n, size: 0x1000, name: '/opt/orca/lib/real.dylib' },
      { base: 0x2000_0000n, size: 0x1000, name: '/opt/orca/lib/fake.dylib' }
    ]
    const { dump } = buildDump({
      exception: { code: 11, address: 0x2000_0024n },
      modules,
      // Honest for one record; the count says two, as a corrupt header does.
      moduleListDeclaredSize: 4 + 108
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBeUndefined()
    expect(signature?.moduleListStatus).toBe('truncated')
  })

  it('refuses to name a module whose name region is missing from the dump', () => {
    const { dump } = buildDump({
      exception: { code: 11, address: 0x1000_0024n },
      modules: [{ base: 0x1000_0000n, size: 0x1000, name: null }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBeUndefined()
    expect(signature?.faultingModuleOffset).toBeUndefined()
    expect(signature?.moduleListStatus).toBe('unreadable')
    expect(minidumpSignatureDetails(signature!).minidumpModuleListStatus).toBe('unreadable')
  })

  it('still names the faulting module when an unrelated module name is unreadable', () => {
    const { dump } = buildDump({
      exception: { code: 11, address: 0x1000_0024n },
      modules: [
        { base: 0x2000_0000n, size: 0x1000, name: null },
        { base: 0x1000_0000n, size: 0x1000, name: '/opt/orca/lib/real.dylib' }
      ]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('real.dylib')
    expect(signature?.faultingModuleOffset).toBe('0x24')
    expect(signature?.moduleListStatus).toBeUndefined()
  })

  it('keeps an unreadable name outside every image range from clouding absence', () => {
    const { dump } = buildDump({
      exception: { code: 11, address: 0x10n },
      modules: [{ base: 0x2000_0000n, size: 0x1000, name: null }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBeUndefined()
    expect(signature?.moduleListStatus).toBeUndefined()
  })

  it('reads a module list padded to the 64-bit record alignment', () => {
    const { dump } = buildDump({
      exception: { code: 11, address: 0x1000_0024n },
      modules: [{ base: 0x1000_0000n, size: 0x1000, name: '/opt/orca/lib/real.dylib' }],
      moduleListPadded: true
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBe('real.dylib')
    expect(signature?.faultingModuleOffset).toBe('0x24')
    expect(signature?.moduleListStatus).toBeUndefined()
  })

  it('refuses to call a list complete when its size matches no known layout', () => {
    const { dump } = buildDump({
      exception: { code: 11, address: 0x10n },
      modules: [{ base: 0x1000_0000n, size: 0x1000, name: '/opt/orca/lib/real.dylib' }],
      // Neither 4 + 108 nor 8 + 108: the record offsets are unknowable.
      moduleListDeclaredSize: 6 + 108
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.moduleListStatus).toBe('unreadable')
  })

  it('refuses to call a list complete when its declared range runs into another stream', () => {
    const { dump } = buildDump({
      // Nothing in the dump covers this address; the reader must not be told so
      // on the strength of a walk that read another stream as a module record.
      exception: { code: 0x1000, address: 0x10n },
      modules: [{ base: 0x1000_0000n, size: 0x1000, name: '/opt/orca/lib/real.dylib' }],
      // Count and declared size over-declare in lockstep, so record #1 is the
      // exception stream's bytes — the one corruption their agreement hides.
      declaredModuleCount: 2,
      moduleListDeclaredSize: 4 + 2 * 108
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.moduleListStatus).toBe('unreadable')
    expect(minidumpSignatureDetails(signature!).minidumpModuleListStatus).toBe('unreadable')
  })

  it('does not name a module read at offsets it could not establish', () => {
    const { dump } = buildDump({
      exception: { code: 11, address: 0x1000_0024n },
      modules: [{ base: 0x1000_0000n, size: 0x1000, name: '/opt/orca/lib/real.dylib' }],
      // Neither 4 + 108 nor 8 + 108, so the record offset below is a guess.
      moduleListDeclaredSize: 6 + 108
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.faultingModule).toBeUndefined()
    expect(signature?.faultingModuleOffset).toBeUndefined()
    expect(signature?.moduleListStatus).toBe('unreadable')
  })

  it('keeps a fully read list silent so a missing module still means absent', () => {
    const { dump } = buildDump({
      exception: { code: 11, address: 0x10n },
      modules: [{ base: 0x7ff7_0000_0000n, size: 0x1000, name: '/opt/orca/orca' }]
    })

    const signature = parseMinidumpCrashSignature(dump)

    expect(signature?.moduleListStatus).toBeUndefined()
    expect(minidumpSignatureDetails(signature!).minidumpModuleListStatus).toBeUndefined()
  })
})
