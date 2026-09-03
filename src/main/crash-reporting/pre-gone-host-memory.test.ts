import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSystemMemoryDetails, setSystemMemoryInfoReaderForTest } from './system-memory-details'
import { setSwapVolumeFreeSpaceReaderForTest } from './swap-volume-free-space'
import {
  PRE_GONE_SYSTEM_MEMORY_SAMPLE_INTERVAL_MS,
  samplePreGoneSystemMemory
} from './pre-gone-host-memory'
import {
  buildProcessGoneCrashDetails,
  PROCESS_METRICS_PRE_GONE_SAMPLE_INTERVAL_MS,
  resetPreGoneCrashSamplingForTest,
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

const UNDER_COMMIT_PRESSURE = {
  total: 16_000 * 1024,
  free: 400 * 1024,
  swapTotal: 48_000 * 1024,
  swapFree: 200 * 1024
}

const AFTER_THE_CORPSE_RELEASED = {
  total: 16_000 * 1024,
  free: 3_000 * 1024,
  swapTotal: 48_000 * 1024,
  swapFree: 2_900 * 1024
}

describe('pre-gone host memory', () => {
  beforeEach(() => {
    resetPreGoneCrashSamplingForTest()
    setSystemMemoryInfoReaderForTest(null)
    setSwapVolumeFreeSpaceReaderForTest(null)
    appMetricsMock.mockReturnValue(BROWSER_AND_RENDERER)
  })

  it('carries a pre-gone host reading, not only the post-mortem one', async () => {
    setSystemMemoryInfoReaderForTest(() => UNDER_COMMIT_PRESSURE)
    setSwapVolumeFreeSpaceReaderForTest(() => Promise.resolve(120))
    await samplePreGoneSystemMemory(Date.now() - 5_000)

    // The renderer dies; its ~400 MB returns to the OS, so the gone-time read
    // now shows a much healthier machine than the one that refused the alloc.
    setSystemMemoryInfoReaderForTest(() => AFTER_THE_CORPSE_RELEASED)
    appMetricsMock.mockReturnValue(BROWSER_ONLY)

    const details = buildProcessGoneCrashDetails({ processType: 'renderer' }, 'renderer')

    expect(details.systemMemorySwapFreeMB).toBe(2_900)
    expect(details.systemMemoryPreGoneSwapFreeMB).toBe(200)
    expect(details.systemMemoryPreGoneFreeMB).toBe(400)
    expect(details.systemMemoryPreGoneTotalMB).toBe(16_000)
    // Why: host memory keeps its own key family, so a `systemMemory` prefix scan sees both reads.
    expect(
      Object.keys(details).filter((key) => key.startsWith('processMetricsPreGoneSystem'))
    ).toEqual([])
  })

  // Why this decides the cluster: 200 MB available commit is only a REFUSAL when
  // the pagefile cannot grow, which is what the volume's free space says.
  it('reports swap-volume free space so low commit can be told from refused commit', async () => {
    setSystemMemoryInfoReaderForTest(() => UNDER_COMMIT_PRESSURE)
    setSwapVolumeFreeSpaceReaderForTest(() => Promise.resolve(120))
    await samplePreGoneSystemMemory(Date.now() - 5_000)

    const details = buildProcessGoneCrashDetails({ processType: 'renderer' }, 'renderer')

    expect(details.systemMemoryPreGoneSwapVolumeFreeMB).toBe(120)
  })

  it('labels the reading with the pressure verdict the platform can actually give', () => {
    setSystemMemoryInfoReaderForTest(() => UNDER_COMMIT_PRESSURE)
    expect(getSystemMemoryDetails('win32').systemMemoryPressureSignal).toBe('available-commit')

    setSystemMemoryInfoReaderForTest(() => ({ total: 16_000 * 1024, free: 400 * 1024 }))
    expect(getSystemMemoryDetails('linux').systemMemoryPressureSignal).toBe('none')

    setSystemMemoryInfoReaderForTest(() => ({ total: 16_000 * 1024, available: 900 * 1024 }))
    expect(getSystemMemoryDetails('linux').systemMemoryPressureSignal).toBe('mem-available')

    // darwin free/fileBacked/purgeable answer reclaimability, never pressure.
    setSystemMemoryInfoReaderForTest(() => ({
      total: 16_000 * 1024,
      free: 272 * 1024,
      fileBacked: 2_694 * 1024,
      purgeable: 0
    }))
    expect(getSystemMemoryDetails('darwin').systemMemoryPressureSignal).toBe('none')
  })

  it('samples the host far more often than the process-metric sweep', () => {
    // Why: a ~37 s old host reading cannot see a transient commit refusal.
    expect(PRE_GONE_SYSTEM_MEMORY_SAMPLE_INTERVAL_MS).toBeLessThan(
      PROCESS_METRICS_PRE_GONE_SAMPLE_INTERVAL_MS / 2
    )
  })

  it('keeps a failed host read from erasing the process-metric sample', async () => {
    samplePreGoneProcessMetrics(Date.now() - 5_000)
    setSystemMemoryInfoReaderForTest(() => {
      throw new Error('getSystemMemoryInfo unavailable')
    })
    await samplePreGoneSystemMemory(Date.now() - 5_000)
    setSystemMemoryInfoReaderForTest(null)

    const details = buildProcessGoneCrashDetails({ processType: 'renderer' }, 'renderer')

    expect(details.processMetricsPreGoneRendererWorkingSetMB).toBe(400)
    expect(Object.keys(details).filter((key) => key.startsWith('systemMemoryPreGone'))).toEqual([])
  })
})
