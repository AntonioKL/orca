import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildGpuCrashDiagnostics, GpuCrashDiagnosticsRecorder } from './gpu-crash-diagnostics'

const FEATURE_STATUS = {
  gpu_compositing: 'enabled',
  rasterization: 'enabled',
  webgl: 'enabled',
  webgl2: 'enabled',
  video_decode: 'enabled'
}

const BASIC_INFO = {
  gpuDevice: [
    {
      active: false,
      vendorId: 0x8086,
      deviceId: 0x9a49,
      vendorString: 'Intel',
      deviceString: 'Integrated GPU'
    },
    {
      active: true,
      vendorId: 0x10de,
      deviceId: 0x2684,
      vendorString: 'NVIDIA',
      deviceString: 'Discrete GPU',
      driverVendor: 'NVIDIA',
      driverVersion: '32.0.15.6094'
    }
  ],
  auxAttributes: {
    glVendor: 'Google Inc.',
    glRenderer: 'ANGLE (NVIDIA, D3D11)',
    glVersion: 'OpenGL ES 3.0'
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value) => resolvePromise?.(value)
  }
}

describe('buildGpuCrashDiagnostics', () => {
  it('keeps only the active GPU identity, driver, rendering backend, and feature status', () => {
    expect(
      buildGpuCrashDiagnostics({ info: BASIC_INFO, level: 'complete' }, FEATURE_STATUS)
    ).toEqual({
      gpuInfoLevel: 'complete',
      gpuDeviceCount: 2,
      gpuVendorId: 0x10de,
      gpuDeviceId: 0x2684,
      gpuVendor: 'NVIDIA',
      gpuDevice: 'Discrete GPU',
      gpuDriverVendor: 'NVIDIA',
      gpuDriverVersion: '32.0.15.6094',
      gpuGlVendor: 'Google Inc.',
      gpuGlRenderer: 'ANGLE (NVIDIA, D3D11)',
      gpuGlVersion: 'OpenGL ES 3.0',
      gpuCompositingStatus: 'enabled',
      gpuRasterizationStatus: 'enabled',
      gpuWebglStatus: 'enabled',
      gpuWebgl2Status: 'enabled',
      gpuVideoDecodeStatus: 'enabled'
    })
  })

  it('degrades malformed or unavailable GPU info without copying arbitrary fields', () => {
    expect(
      buildGpuCrashDiagnostics(
        {
          level: 'basic',
          info: {
            gpuDevice: [{ active: true, vendorId: Number.NaN, secret: 'do not copy' }],
            machineModelName: 'do not copy'
          }
        },
        { webgl: 'unavailable', unexpected: 'do not copy' }
      )
    ).toEqual({
      gpuInfoLevel: 'basic',
      gpuDeviceCount: 1,
      gpuWebglStatus: 'unavailable'
    })
    expect(buildGpuCrashDiagnostics(null, null)).toEqual({ gpuInfoLevel: 'unavailable' })
  })
})

describe('GpuCrashDiagnosticsRecorder', () => {
  it('warms complete info and records one breadcrumb across a crash burst', async () => {
    const recordBreadcrumb = vi.fn()
    const provider = {
      getGPUInfo: vi.fn(async (level: 'basic' | 'complete') => ({
        ...BASIC_INFO,
        gpuDevice: BASIC_INFO.gpuDevice.map((device) => ({
          ...device,
          ...(level === 'complete' ? { driverVersion: 'complete-driver' } : {})
        }))
      })),
      getGPUFeatureStatus: vi.fn(() => FEATURE_STATUS)
    }
    const recorder = new GpuCrashDiagnosticsRecorder({ provider, recordBreadcrumb })

    recorder.warm()
    await vi.waitFor(() => {
      expect(provider.getGPUInfo).toHaveBeenCalledTimes(2)
    })
    await Promise.resolve()
    await recorder.record()
    await recorder.record()

    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        gpuInfoLevel: 'complete',
        gpuVendorId: 0x10de,
        gpuDeviceId: 0x2684,
        gpuDriverVersion: 'complete-driver'
      })
    )
  })

  it('uses promptly available basic info when complete collection is still pending', async () => {
    const complete = deferred<unknown>()
    const recordBreadcrumb = vi.fn()
    const provider = {
      getGPUInfo: vi.fn((level: 'basic' | 'complete') =>
        level === 'basic' ? Promise.resolve(BASIC_INFO) : complete.promise
      ),
      getGPUFeatureStatus: vi.fn(() => FEATURE_STATUS)
    }
    const recorder = new GpuCrashDiagnosticsRecorder({ provider, recordBreadcrumb })

    recorder.warm()
    await recorder.record()

    expect(recordBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        gpuInfoLevel: 'basic',
        gpuVendorId: 0x10de,
        gpuDriverVersion: '32.0.15.6094'
      })
    )
    complete.resolve(BASIC_INFO)
  })

  it('still records collection status when Electron rejects both GPU info calls', async () => {
    const recordBreadcrumb = vi.fn()
    const provider = {
      getGPUInfo: vi.fn(async () => {
        throw new Error('GPU access disabled')
      }),
      getGPUFeatureStatus: vi.fn(() => {
        throw new Error('GPU teardown')
      })
    }
    const recorder = new GpuCrashDiagnosticsRecorder({ provider, recordBreadcrumb })

    recorder.warm()
    await recorder.record()

    expect(recordBreadcrumb).toHaveBeenCalledWith({ gpuInfoLevel: 'unavailable' })
  })
})

describe('GPU crash diagnostics production wiring', () => {
  it('records hardware diagnostics before engaging fallback from the raw GPU event', () => {
    const source = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')
    const listenerStart = source.indexOf("app.on('child-process-gone'")
    expect(listenerStart).toBeGreaterThan(0)
    const listener = source.slice(listenerStart, source.indexOf('\n  })', listenerStart))
    expect(source).toMatch(
      /recordBreadcrumb: \(data\) =>\s*recordDurableCrashBreadcrumb\('gpu_crash_hardware', data\)/
    )
    expect(listener).toMatch(
      /isGpuFallbackCrashCandidate\([\s\S]*?gpuCrashDiagnostics\?\.record\(\)[\s\S]*?handleGpuChildCrash\(/
    )
  })
})
