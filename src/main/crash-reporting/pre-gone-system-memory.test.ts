import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setSystemMemoryInfoReaderForTest } from './gone-time-system-memory'
import {
  buildProcessGoneCrashDetails,
  resetPreGoneProcessMetricsSamplingForTest,
  samplePreGoneProcessMetrics
} from './process-gone-diagnostics'

type MetricFixture = {
  pid: number
  creationTime: number
  type: string
  memory: { workingSetSize: number; peakWorkingSetSize?: number; privateBytes?: number }
}

const { appMetricsMock } = vi.hoisted(() => ({
  appMetricsMock: vi.fn<() => MetricFixture[]>(() => [])
}))

vi.mock('electron', () => ({ app: { getAppMetrics: appMetricsMock } }))

const BROWSER_AND_RENDERER: MetricFixture[] = [
  { pid: 10, creationTime: 1, type: 'Browser', memory: { workingSetSize: 1024 * 250 } },
  {
    pid: 11,
    creationTime: 2,
    type: 'Tab',
    memory: { workingSetSize: 1024 * 400, peakWorkingSetSize: 1024 * 420, privateBytes: 1024 * 260 }
  }
]

const BROWSER_ONLY: MetricFixture[] = [BROWSER_AND_RENDERER[0]]

describe('pre-gone system memory', () => {
  beforeEach(() => {
    resetPreGoneProcessMetricsSamplingForTest()
    setSystemMemoryInfoReaderForTest(null)
    appMetricsMock.mockReturnValue(BROWSER_AND_RENDERER)
  })

  it('carries a pre-gone system-memory reading, not only the post-mortem one', () => {
    // Windows commit pressure at sample time: 400 MB physical free, 200 MB commit left.
    setSystemMemoryInfoReaderForTest(() => ({
      total: 16_000 * 1024,
      free: 400 * 1024,
      swapTotal: 48_000 * 1024,
      swapFree: 200 * 1024
    }))
    samplePreGoneProcessMetrics(Date.now() - 5_000)

    // The renderer dies; its ~400 MB returns to the OS, so the gone-time read
    // now shows a much healthier machine than the one that refused the alloc.
    setSystemMemoryInfoReaderForTest(() => ({
      total: 16_000 * 1024,
      free: 3_000 * 1024,
      swapTotal: 48_000 * 1024,
      swapFree: 2_900 * 1024
    }))
    appMetricsMock.mockReturnValue(BROWSER_ONLY)

    const details = buildProcessGoneCrashDetails({ processType: 'renderer' }, 'renderer')

    expect(details.systemMemorySwapFreeMB).toBe(2_900)
    expect(details.processMetricsPreGoneSystemMemorySwapFreeMB).toBe(200)
    expect(details.processMetricsPreGoneSystemMemoryFreeMB).toBe(400)
    expect(details.processMetricsPreGoneSystemMemoryTotalMB).toBe(16_000)
  })

  it('leaves the pre-gone sample free of system-memory keys when the reading is unavailable', () => {
    samplePreGoneProcessMetrics(Date.now() - 5_000)

    const details = buildProcessGoneCrashDetails({ processType: 'renderer' }, 'renderer')

    expect(details.processMetricsPreGoneRendererWorkingSetMB).toBe(400)
    expect(
      Object.keys(details).filter((key) => key.startsWith('processMetricsPreGoneSystemMemory'))
    ).toEqual([])
  })
})
