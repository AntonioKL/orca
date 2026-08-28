import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'

type GpuInfoLevel = 'basic' | 'complete'

type GpuInfoProvider = {
  getGPUInfo(infoType: GpuInfoLevel): Promise<unknown>
  getGPUFeatureStatus(): unknown
}

type GpuCrashDiagnosticsRecorderOptions = {
  provider: GpuInfoProvider
  recordBreadcrumb: (data: CrashReportBreadcrumbData) => void
}

type GpuInfoSnapshot = {
  info: unknown
  level: GpuInfoLevel
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function addString(target: CrashReportBreadcrumbData, key: string, value: unknown): void {
  const safe = nonEmptyString(value)
  if (safe !== undefined) {
    target[key] = safe
  }
}

function addNumber(target: CrashReportBreadcrumbData, key: string, value: unknown): void {
  const safe = finiteNumber(value)
  if (safe !== undefined) {
    target[key] = safe
  }
}

function activeGpuDevice(info: Record<string, unknown>): {
  device: Record<string, unknown> | null
  count: number
} {
  const devices = Array.isArray(info.gpuDevice)
    ? info.gpuDevice.map(recordValue).filter((device) => device !== null)
    : []
  return {
    device: devices.find((device) => device.active === true) ?? devices[0] ?? null,
    count: devices.length
  }
}

function addFeatureStatuses(details: CrashReportBreadcrumbData, featureStatus: unknown): void {
  const status = recordValue(featureStatus)
  if (!status) {
    return
  }
  addString(details, 'gpuCompositingStatus', status.gpu_compositing)
  addString(details, 'gpuRasterizationStatus', status.rasterization)
  addString(details, 'gpuWebglStatus', status.webgl)
  addString(details, 'gpuWebgl2Status', status.webgl2)
  addString(details, 'gpuVideoDecodeStatus', status.video_decode)
}

export function buildGpuCrashDiagnostics(
  snapshot: GpuInfoSnapshot | null,
  featureStatus: unknown
): CrashReportBreadcrumbData {
  const details: CrashReportBreadcrumbData = {
    gpuInfoLevel: snapshot?.level ?? 'unavailable'
  }
  addFeatureStatuses(details, featureStatus)
  const info = recordValue(snapshot?.info)
  if (!info) {
    return details
  }

  const { device, count } = activeGpuDevice(info)
  details.gpuDeviceCount = count
  if (device) {
    addNumber(details, 'gpuVendorId', device.vendorId)
    addNumber(details, 'gpuDeviceId', device.deviceId)
    addString(details, 'gpuVendor', device.vendorString)
    addString(details, 'gpuDevice', device.deviceString)
    addString(details, 'gpuDriverVendor', device.driverVendor)
    addString(details, 'gpuDriverVersion', device.driverVersion)
  }

  const aux = recordValue(info.auxAttributes)
  if (aux) {
    addString(details, 'gpuGlVendor', aux.glVendor)
    addString(details, 'gpuGlRenderer', aux.glRenderer)
    addString(details, 'gpuGlVersion', aux.glVersion)
  }
  return details
}

/** Captures GPU identity before a crash and emits it once when a Windows GPU burst starts. */
export class GpuCrashDiagnosticsRecorder {
  private readonly provider: GpuInfoProvider
  private readonly recordBreadcrumb: (data: CrashReportBreadcrumbData) => void
  private basicInfoPromise: Promise<void> | null = null
  private completeInfoPromise: Promise<void> | null = null
  private basicInfo: unknown = null
  private completeInfo: unknown = null
  private recorded = false

  constructor(options: GpuCrashDiagnosticsRecorderOptions) {
    this.provider = options.provider
    this.recordBreadcrumb = options.recordBreadcrumb
  }

  warm(): void {
    void this.ensureBasicInfo()
    void this.ensureCompleteInfo()
  }

  async record(): Promise<void> {
    if (this.recorded) {
      return
    }
    this.recorded = true
    let featureStatus: unknown = null
    try {
      featureStatus = this.provider.getGPUFeatureStatus()
    } catch {
      // GPU teardown can race this read; device identity is still useful.
    }
    await this.ensureBasicInfo()
    const snapshot = this.preferredSnapshot()
    this.recordBreadcrumb(buildGpuCrashDiagnostics(snapshot, featureStatus))
  }

  private ensureBasicInfo(): Promise<void> {
    this.basicInfoPromise ??= this.provider
      .getGPUInfo('basic')
      .then((info) => {
        this.basicInfo = info
      })
      .catch(() => undefined)
    return this.basicInfoPromise
  }

  private ensureCompleteInfo(): Promise<void> {
    this.completeInfoPromise ??= this.provider
      .getGPUInfo('complete')
      .then((info) => {
        this.completeInfo = info
      })
      .catch(() => undefined)
    return this.completeInfoPromise
  }

  private preferredSnapshot(): GpuInfoSnapshot | null {
    if (this.completeInfo !== null) {
      return { info: this.completeInfo, level: 'complete' }
    }
    if (this.basicInfo !== null) {
      return { info: this.basicInfo, level: 'basic' }
    }
    return null
  }
}
