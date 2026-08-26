import { describe, expect, it } from 'vitest'
import { minidumpSignatureDetails, parseMinidumpCrashSignature } from './minidump-crash-signature'
import { sanitizeCrashReportDetails } from '../../shared/crash-reporting'

const STREAM_TYPE_MODULE_LIST = 4
const STREAM_TYPE_EXCEPTION = 6
const STREAM_TYPE_SYSTEM_INFO = 7
const STREAM_TYPE_CRASHPAD_INFO = 0x43500001

// MINIDUMP_SYSTEM_INFO.ProcessorArchitecture / .PlatformId as Crashpad writes them.
const ARCH_AMD64 = 9
const ARCH_ARM64 = 12
const PLATFORM_WIN32_NT = 2
const PLATFORM_LINUX = 0x8201
const PLATFORM_MAC_OS_X = 0x8101

const PRODUCT_IMAGES = ['Orca.exe']

/** CONTEXT_AMD64 with ContextFlags at 48 and Rip at 248. */
function amd64Context(rip: bigint): Buffer {
  const context = Buffer.alloc(1232)
  context.writeUInt32LE(0x0010_003f, 48)
  context.writeBigUInt64LE(rip, 248)
  return context
}

/** MinidumpContextARM64 with ContextFlags at 0 and pc at 264. */
function arm64Context(pc: bigint): Buffer {
  const context = Buffer.alloc(912)
  context.writeUInt32LE(0x0040_0003, 0)
  context.writeBigUInt64LE(pc, 264)
  return context
}

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

type BuiltDump = { dump: Buffer; moduleListRva?: number }

/**
 * @param annotations key/value pairs written as MinidumpAnnotation objects
 *   hanging off a module's crashpad info, which is where Chromium crash keys
 *   (including LOG_FATAL) actually live.
 */
function buildDump(options: {
  annotations?: Record<string, string>
  simpleAnnotations?: Record<string, string>
  exception?: {
    code: number
    address: bigint
    context?: Buffer
    contextSize?: number
    contextRva?: number
    /** Size the stream directory declares, to model a truncated record. */
    streamSize?: number
  }
  modules?: { base: bigint; size: number; name: string }[]
  systemInfo?: { architecture: number; platformId: number }
}): BuiltDump {
  const streamCount =
    1 +
    (options.exception ? 1 : 0) +
    (options.modules && options.modules.length > 0 ? 1 : 0) +
    (options.systemInfo ? 1 : 0)
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
    location(moduleLinkBuf.length, moduleLinkRva)
  ])
  const crashpadInfoRva = builder.append(crashpadInfoBuf)
  streams.push({
    type: STREAM_TYPE_CRASHPAD_INFO,
    size: crashpadInfoBuf.length,
    rva: crashpadInfoRva
  })

  let moduleListRva: number | undefined
  if (options.modules && options.modules.length > 0) {
    const nameRvas = options.modules.map((module) => builder.utf16String(module.name))
    const listBuf = Buffer.alloc(4 + options.modules.length * 108)
    listBuf.writeUInt32LE(options.modules.length, 0)
    options.modules.forEach((module, index) => {
      const at = 4 + index * 108
      listBuf.writeBigUInt64LE(module.base, at)
      listBuf.writeUInt32LE(module.size, at + 8)
      listBuf.writeUInt32LE(nameRvas[index], at + 20)
    })
    moduleListRva = builder.append(listBuf)
    streams.push({
      type: STREAM_TYPE_MODULE_LIST,
      size: listBuf.length,
      rva: moduleListRva
    })
  }

  if (options.systemInfo) {
    const systemInfoBuf = Buffer.alloc(56)
    systemInfoBuf.writeUInt16LE(options.systemInfo.architecture, 0)
    systemInfoBuf.writeUInt32LE(options.systemInfo.platformId, 20)
    streams.push({
      type: STREAM_TYPE_SYSTEM_INFO,
      size: systemInfoBuf.length,
      rva: builder.append(systemInfoBuf)
    })
  }

  if (options.exception) {
    const context = options.exception.context
    const contextRva = context ? builder.append(context) : 0
    const exceptionBuf = Buffer.alloc(168)
    exceptionBuf.writeUInt32LE(1234, 0) // ThreadId
    exceptionBuf.writeUInt32LE(options.exception.code, 8)
    exceptionBuf.writeBigUInt64LE(options.exception.address, 24)
    if (context) {
      exceptionBuf.writeUInt32LE(options.exception.contextSize ?? context.length, 160)
      exceptionBuf.writeUInt32LE(options.exception.contextRva ?? contextRva, 164)
    }
    streams.push({
      type: STREAM_TYPE_EXCEPTION,
      size: options.exception.streamSize ?? exceptionBuf.length,
      rva: builder.append(exceptionBuf)
    })
  }

  return { dump: builder.build(streams), moduleListRva }
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

  it('resolves the faulting module from a Windows exception address', () => {
    const { dump } = buildDump({
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_WIN32_NT },
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
          name: 'C:\\Windows\\System32\\KERNELBASE.dll'
        }
      ]
    })

    const signature = parseMinidumpCrashSignature(dump, {
      productImageNames: PRODUCT_IMAGES
    })

    expect(signature?.exceptionCode).toBe(0x80000003)
    expect(signature?.exceptionAddress).toBe('0x7ff800001234')
    // A separately loaded module does localize the fault, so it keeps its name.
    expect(signature?.faultingModule).toEqual({
      state: 'resolved',
      module: 'KERNELBASE.dll',
      offset: '0x1234',
      identity: 'separate-module',
      addressSource: 'exception-address'
    })
  })

  it('marks the Chromium-linked product image as not localizing the fault', () => {
    // The shape seen in the field: 0x80000003 inside the Orca.exe image band.
    const { dump } = buildDump({
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_WIN32_NT },
      exception: { code: 0x80000003, address: 0x7ff7_7bfd_606an },
      modules: [
        {
          base: 0x7ff7_7551_0000n,
          size: 0x0800_0000,
          name: 'C:\\Program Files\\Orca\\Orca.exe'
        }
      ]
    })

    const signature = parseMinidumpCrashSignature(dump, {
      productImageNames: PRODUCT_IMAGES
    })

    expect(signature?.faultingModule).toMatchObject({
      state: 'resolved',
      module: 'Orca.exe',
      identity: 'product-image'
    })
  })

  it('identifies the product image by name, not by index or image size', () => {
    const { dump } = buildDump({
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_WIN32_NT },
      // First in the list, and larger than any plausible size floor.
      exception: { code: 0xc0000005, address: 0x7ff7_0000_1000n },
      modules: [
        {
          base: 0x7ff7_0000_0000n,
          size: 0x0a00_0000,
          name: 'C:\\vendor\\huge_gpu_driver.dll'
        },
        {
          base: 0x7ff8_0000_0000n,
          size: 0x0300_0000,
          name: 'C:\\Program Files\\Orca\\Orca.exe'
        }
      ]
    })

    const signature = parseMinidumpCrashSignature(dump, {
      productImageNames: PRODUCT_IMAGES
    })

    expect(signature?.faultingModule).toMatchObject({
      module: 'huge_gpu_driver.dll',
      identity: 'separate-module'
    })
  })

  it('leaves the image unidentified when the product image name is unknown', () => {
    const { dump } = buildDump({
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_WIN32_NT },
      exception: { code: 0xc0000005, address: 0x7ff7_0000_1000n },
      modules: [{ base: 0x7ff7_0000_0000n, size: 0x1_0000, name: 'C:\\x\\thing.dll' }]
    })

    const signature = parseMinidumpCrashSignature(dump, {
      productImageNames: []
    })

    expect(signature?.faultingModule).toMatchObject({
      module: 'thing.dll',
      identity: 'unidentified'
    })
  })

  it('reads the POSIX instruction pointer from the thread context, not si_addr', () => {
    // si_addr lands in a mapped module; the crashing code is somewhere else.
    const { dump } = buildDump({
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_LINUX },
      exception: {
        code: 11,
        address: 0x27d7_87ec_0000n,
        context: amd64Context(0x5555_0000_2000n)
      },
      modules: [
        {
          base: 0x27d7_87ec_0000n,
          size: 0x10_0000,
          name: '/usr/lib/libdata.so'
        },
        { base: 0x5555_0000_0000n, size: 0x0300_0000, name: '/opt/Orca/orca' }
      ]
    })

    const signature = parseMinidumpCrashSignature(dump, {
      productImageNames: ['orca']
    })

    expect(signature?.exceptionAddress).toBe('0x27d787ec0000')
    expect(signature?.faultingModule).toEqual({
      state: 'resolved',
      module: 'orca',
      offset: '0x2000',
      identity: 'product-image',
      addressSource: 'instruction-pointer'
    })
  })

  it('reads the arm64 program counter for a macOS dump', () => {
    const { dump } = buildDump({
      systemInfo: { architecture: ARCH_ARM64, platformId: PLATFORM_MAC_OS_X },
      exception: {
        code: 10,
        address: 0x8n,
        context: arm64Context(0x1_0400_1000n)
      },
      modules: [
        {
          base: 0x1_0400_0000n,
          size: 0x0300_0000,
          name: '/Applications/Orca.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
        }
      ]
    })

    const signature = parseMinidumpCrashSignature(dump, {
      productImageNames: ['Electron Framework']
    })

    expect(signature?.faultingModule).toMatchObject({
      module: 'Electron Framework',
      identity: 'product-image',
      addressSource: 'instruction-pointer'
    })
  })

  it('never names a module from si_addr when the POSIX thread context is missing', () => {
    // Without this the module owning the bad pointer is reported as the faulter.
    const { dump } = buildDump({
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_LINUX },
      exception: { code: 11, address: 0x27d7_87ec_0000n },
      modules: [
        {
          base: 0x27d7_87ec_0000n,
          size: 0x10_0000,
          name: '/usr/lib/libdata.so'
        }
      ]
    })

    const signature = parseMinidumpCrashSignature(dump, {
      productImageNames: ['orca']
    })

    expect(signature?.faultingModule).toMatchObject({
      state: 'not-applicable',
      reason: expect.stringContaining('si_addr')
    })
    expect(signature?.faultingModule).not.toHaveProperty('module')
  })

  it('refuses the context when its ContextFlags name a different CPU', () => {
    const wrongCpu = amd64Context(0x5555_0000_2000n)
    wrongCpu.writeUInt32LE(0x0040_0003, 48) // arm64 flags in the amd64 slot
    const { dump } = buildDump({
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_LINUX },
      exception: { code: 11, address: 0x10n, context: wrongCpu },
      modules: [{ base: 0x5555_0000_0000n, size: 0x10_0000, name: '/opt/Orca/orca' }]
    })

    const signature = parseMinidumpCrashSignature(dump, {
      productImageNames: ['orca']
    })

    expect(signature?.faultingModule).toMatchObject({
      state: 'not-applicable',
      reason: expect.stringContaining('does not identify itself')
    })
  })

  it('refuses a truncated thread context instead of reading past it', () => {
    const { dump } = buildDump({
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_LINUX },
      exception: {
        code: 11,
        address: 0x10n,
        context: amd64Context(0x5555_0000_2000n),
        contextSize: 64
      },
      modules: [{ base: 0x5555_0000_0000n, size: 0x10_0000, name: '/opt/Orca/orca' }]
    })

    const signature = parseMinidumpCrashSignature(dump, {
      productImageNames: ['orca']
    })

    expect(signature?.faultingModule).toMatchObject({
      state: 'not-applicable',
      reason: expect.stringContaining('truncated')
    })
  })

  it('separates a context the dump omits from one it could not reach', () => {
    const posix = {
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_LINUX },
      modules: [{ base: 0x5555_0000_0000n, size: 0x10_0000, name: '/opt/Orca/orca' }]
    }
    const reason = (dump: Buffer): string => {
      const resolution = parseMinidumpCrashSignature(dump, { productImageNames: ['orca'] })
        ?.faultingModule
      return resolution && 'reason' in resolution ? resolution.reason : ''
    }

    // Descriptor present and zeroed: the dump really did record no context.
    expect(reason(buildDump({ ...posix, exception: { code: 11, address: 0x10n } }).dump)).toContain(
      'records no thread context'
    )

    // Record stops before the descriptor: unread, so absence is not observed.
    const short = buildDump({
      ...posix,
      exception: {
        code: 11,
        address: 0x10n,
        context: amd64Context(0x5555_0000_2000n),
        streamSize: 160
      }
    })
    expect(reason(short.dump)).toContain('truncated before it reaches the thread context')
    expect(reason(short.dump)).not.toContain('records no thread context')

    // Descriptor points past the end of a clipped dump.
    const dangling = buildDump({
      ...posix,
      exception: {
        code: 11,
        address: 0x10n,
        context: amd64Context(0x5555_0000_2000n),
        contextRva: 0x7fff_0000
      }
    })
    expect(reason(dangling.dump)).toContain("context is truncated in this dump")
    expect(reason(dangling.dump)).not.toContain('records no thread context')
  })

  it('will not read an unidentified platform exception address as an instruction pointer', () => {
    const { dump } = buildDump({
      exception: { code: 11, address: 0x7ff8_0000_1234n },
      modules: [{ base: 0x7ff8_0000_0000n, size: 0x10_0000, name: 'chrome_elf.dll' }]
    })

    const signature = parseMinidumpCrashSignature(dump, {
      productImageNames: PRODUCT_IMAGES
    })

    expect(signature?.exceptionAddress).toBe('0x7ff800001234')
    expect(signature?.faultingModule).toMatchObject({
      state: 'unknown',
      reason: expect.stringContaining('does not say which OS')
    })
  })

  it('says a dump with no exception record has no faulting module to name', () => {
    const { dump } = buildDump({ annotations: { ptype: 'renderer' } })

    expect(parseMinidumpCrashSignature(dump)?.faultingModule).toEqual({
      state: 'not-applicable',
      reason: 'this dump records no exception, so nothing faulted at an address'
    })
  })

  it('says the address matched no module rather than that no list existed', () => {
    const { dump } = buildDump({
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_WIN32_NT },
      exception: { code: 0xc0000005, address: 0x10n },
      modules: [{ base: 0x7ff7_0000_0000n, size: 0x1000, name: 'Orca.exe' }]
    })

    const signature = parseMinidumpCrashSignature(dump, {
      productImageNames: PRODUCT_IMAGES
    })

    expect(signature?.faultingModule).toEqual({
      state: 'unknown',
      reason: 'exception address 0x10 is outside every loaded module'
    })
  })

  it('distinguishes an unreadable module list from an absent one', () => {
    const absent = buildDump({
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_WIN32_NT },
      exception: { code: 0xc0000005, address: 0x10n }
    }).dump

    expect(
      parseMinidumpCrashSignature(absent, { productImageNames: PRODUCT_IMAGES })?.faultingModule
    ).toEqual({ state: 'unknown', reason: 'this dump carries no module list' })

    const { dump, moduleListRva } = buildDump({
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_WIN32_NT },
      exception: { code: 0xc0000005, address: 0x10n },
      modules: [{ base: 0x7ff7_0000_0000n, size: 0x1000, name: 'Orca.exe' }]
    })
    // A present list whose count cannot be read is not an empty list.
    const corrupt = Buffer.from(dump)
    corrupt.writeUInt32LE(0xffff_ffff, moduleListRva!)

    expect(
      parseMinidumpCrashSignature(corrupt, {
        productImageNames: PRODUCT_IMAGES
      })?.faultingModule
    ).toEqual({
      state: 'unknown',
      reason: "this dump's module list could not be read"
    })
  })

  it('keeps no orphan offset when the dump does not name the module it hit', () => {
    const { dump } = buildDump({
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_WIN32_NT },
      exception: { code: 0xc0000005, address: 0x7ff7_0000_0100n },
      modules: [{ base: 0x7ff7_0000_0000n, size: 0x1000, name: '' }]
    })

    const signature = parseMinidumpCrashSignature(dump, {
      productImageNames: PRODUCT_IMAGES
    })

    expect(signature?.faultingModule).toEqual({
      state: 'unknown',
      reason:
        'exception address 0x7ff700000100 falls inside a module this dump does not name (image base 0x7ff700000000)'
    })
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
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_WIN32_NT },
      exception: { code: 0x80000003, address: 0x7ff8_0000_1234n },
      modules: [{ base: 0x7ff8_0000_0000n, size: 0x10_0000, name: 'chrome_elf.dll' }]
    })

    const details = minidumpSignatureDetails(
      parseMinidumpCrashSignature(dump, { productImageNames: PRODUCT_IMAGES })!
    )

    expect(details).toMatchObject({
      minidumpCheckMessage: FATAL_LINE,
      minidumpCheckFile: 'render_frame_impl.cc',
      minidumpCheckLine: 4821,
      minidumpProcessType: 'renderer',
      minidumpExceptionCode: '0x80000003',
      minidumpFaultingModuleState: 'resolved',
      minidumpFaultingModule: 'chrome_elf.dll',
      minidumpFaultingModuleOffset: '0x1234',
      minidumpFaultingModuleIdentity: 'separate-module',
      minidumpFaultingModuleAddressSource: 'exception-address',
      minidumpAnnotation_channel: 'stable'
    })
  })

  it('keeps the longest reason inside the detail length cap', () => {
    const wrongCpu = amd64Context(0x5555_0000_2000n)
    wrongCpu.writeUInt32LE(0x0040_0003, 48)
    const { dump } = buildDump({
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_LINUX },
      exception: { code: 11, address: 0x10n, context: wrongCpu }
    })

    const details = minidumpSignatureDetails(parseMinidumpCrashSignature(dump)!)
    const sanitized = sanitizeCrashReportDetails(details)

    // A truncated reason ends mid-sentence and reads as a different claim.
    expect(sanitized.minidumpFaultingModuleReason).toBe(details.minidumpFaultingModuleReason)
    expect(String(details.minidumpFaultingModuleReason)).toContain('si_addr')
  })

  it('publishes why no module was named instead of dropping the field', () => {
    const { dump } = buildDump({
      annotations: { ptype: 'renderer' },
      systemInfo: { architecture: ARCH_AMD64, platformId: PLATFORM_LINUX },
      exception: { code: 11, address: 0x27d7_87ec_0000n },
      modules: [
        {
          base: 0x27d7_87ec_0000n,
          size: 0x10_0000,
          name: '/usr/lib/libdata.so'
        }
      ]
    })

    const details = minidumpSignatureDetails(
      parseMinidumpCrashSignature(dump, { productImageNames: ['orca'] })!
    )

    expect(details.minidumpFaultingModuleState).toBe('not-applicable')
    expect(details.minidumpFaultingModuleReason).toContain('si_addr')
    expect(details.minidumpFaultingModule).toBeUndefined()
    expect(details.minidumpFaultingModuleOffset).toBeUndefined()
  })

  it('does not duplicate the fatal line into an annotation key', () => {
    const { dump } = buildDump({ annotations: { LOG_FATAL: FATAL_LINE } })

    const details = minidumpSignatureDetails(parseMinidumpCrashSignature(dump)!)

    expect(details.minidumpAnnotation_LOG_FATAL).toBeUndefined()
  })
})
