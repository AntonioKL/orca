import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSystemMemoryDetails,
  setSystemMemoryInfoReaderForTest,
  withSwapVolumeFreeSpace
} from './system-memory-details'
import {
  readSwapVolumeFreeSpace,
  setSwapVolumeFreeSpaceReaderForTest
} from './swap-volume-free-space'
import { samplePreGoneSystemMemory } from './pre-gone-host-memory'
import {
  buildProcessGoneCrashDetails,
  resetPreGoneCrashSamplingForTest,
  samplePreGoneProcessMetrics,
  startPreGoneCrashSampling
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
    appMetricsMock.mockClear()
    appMetricsMock.mockReturnValue(BROWSER_AND_RENDERER)
  })

  it('carries a pre-gone host reading, not only the post-mortem one', async () => {
    setSystemMemoryInfoReaderForTest(() => UNDER_COMMIT_PRESSURE)
    setSwapVolumeFreeSpaceReaderForTest(() => Promise.resolve({ freeMB: 120, volume: 'C:' }))
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
    setSwapVolumeFreeSpaceReaderForTest(() => Promise.resolve({ freeMB: 120, volume: 'C:' }))
    await samplePreGoneSystemMemory(Date.now() - 5_000)

    const details = buildProcessGoneCrashDetails({ processType: 'renderer' }, 'renderer')

    expect(details.systemMemoryPreGoneSwapVolumeFreeMB).toBe(120)
    // Which volume was measured: Windows only names the DEFAULT pagefile drive.
    expect(details.systemMemoryPreGoneSwapVolume).toBe('C:')
  })

  it('omits swap-volume free space on Linux, where swap cannot grow into free disk', async () => {
    // Linux swap is a fixed partition, a fixed-size swapfile, or zram; reporting
    // root-fs free space next to SwapFreeMB 0 would read as headroom that is not there.
    setSwapVolumeFreeSpaceReaderForTest(null)

    await expect(readSwapVolumeFreeSpace('linux')).resolves.toBeUndefined()
  })

  it('labels the reading with the pressure verdict the platform can actually give', () => {
    // Windows available commit only decides anything next to the volume the
    // pagefile grows into, so the unqualified read must not claim a verdict.
    setSystemMemoryInfoReaderForTest(() => UNDER_COMMIT_PRESSURE)
    const windowsCommit = getSystemMemoryDetails('win32')
    expect(windowsCommit.systemMemoryPressureSignal).toBe('available-commit-unqualified')
    expect(
      withSwapVolumeFreeSpace(windowsCommit, { freeMB: 120, volume: 'C:' }, 'win32')
        .systemMemoryPressureSignal
    ).toBe('available-commit')

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

  // Why this test exists: startup arms the host sampler on one line, and
  // deleting that line left every other test in this directory green.
  it("arms the host sampler on its own unref'd 10 s timer, not the metric sweep's", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const readHostMemory = vi.fn(() => UNDER_COMMIT_PRESSURE)
    setSystemMemoryInfoReaderForTest(readHostMemory)
    setSwapVolumeFreeSpaceReaderForTest(() => Promise.resolve({ freeMB: 120, volume: 'C:' }))
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    try {
      startPreGoneCrashSampling()

      // Literal millisecond values: asserting the constants against themselves
      // would let a cadence regression through, and 37 s of staleness is the bug.
      expect(setIntervalSpy.mock.calls.map(([, ms]) => ms)).toEqual([60_000, 10_000])
      for (const { value } of setIntervalSpy.mock.results) {
        expect((value as NodeJS.Timeout).hasRef()).toBe(false)
      }
      expect(readHostMemory).toHaveBeenCalledTimes(1)

      readHostMemory.mockReturnValue(AFTER_THE_CORPSE_RELEASED)
      await vi.advanceTimersByTimeAsync(10_000)
      // One host tick, no extra metric sweep: the two samplers run independently.
      expect(readHostMemory).toHaveBeenCalledTimes(2)
      expect(appMetricsMock).toHaveBeenCalledTimes(1)

      const details = buildProcessGoneCrashDetails({}, 'renderer')
      expect(details.systemMemoryPreGoneSampleAgeMs).toBe(0)
      expect(details.systemMemoryPreGoneSwapFreeMB).toBe(2_900)
    } finally {
      setIntervalSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('commits the host reading without waiting on the swap-volume statfs', async () => {
    // Why: statfs is slowest during the paging storm this sampler targets, and
    // a hung volume must not stall or silently skip host sampling.
    setSystemMemoryInfoReaderForTest(() => UNDER_COMMIT_PRESSURE)
    setSwapVolumeFreeSpaceReaderForTest(() => new Promise(() => {}))

    void samplePreGoneSystemMemory(Date.now() - 5_000)
    expect(buildProcessGoneCrashDetails({}, 'renderer').systemMemoryPreGoneSwapFreeMB).toBe(200)

    // A second tick still refreshes the reading while that statfs hangs.
    setSystemMemoryInfoReaderForTest(() => AFTER_THE_CORPSE_RELEASED)
    void samplePreGoneSystemMemory(Date.now())
    expect(buildProcessGoneCrashDetails({}, 'renderer').systemMemoryPreGoneSwapFreeMB).toBe(2_900)
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
