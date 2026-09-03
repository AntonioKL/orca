import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import { readSwapVolumeFreeSpace } from './swap-volume-free-space'
import {
  getSystemMemoryDetails,
  SYSTEM_MEMORY_KEY_PREFIX,
  withSwapVolumeFreeSpace
} from './system-memory-details'

// ─── Pre-gone host memory sampling ──────────────────────────────────
// Why sample at all: the gone-time host read lands after the corpse released
// its pages, so it reports a healthier machine than the one that refused the
// allocation.
// Why 10 s and not the 60 s process-metrics cadence: at 60 s, four of five
// field OOMs carried a ~37 s old host reading — far too stale to see a
// transient commit refusal. A refusal shorter than the interval stays
// invisible; no cadence fixes that.

export const PRE_GONE_SYSTEM_MEMORY_SAMPLE_INTERVAL_MS = 10_000

type CrashReportDetails = Record<string, CrashReportDetailValue>

type PreGoneSystemMemorySample = {
  details: CrashReportDetails
  sampledAtMs: number
  /** Tick that ISSUED the statfs now merged in — never the tick it resolved on. */
  swapVolumeSampledAtMs?: number
}

let preGoneSample: PreGoneSystemMemorySample | null = null
let preGoneTimer: ReturnType<typeof setInterval> | null = null
let swapVolumeReadInFlight = false
let samplingGeneration = 0

function commitHostMemorySample(nowMs: number): boolean {
  try {
    const details = getSystemMemoryDetails()
    if (Object.keys(details).length === 0) {
      return false
    }
    preGoneSample = { details, sampledAtMs: nowMs }
    return true
  } catch {
    // Why: a failed read must not erase the previous good sample.
    return false
  }
}

async function mergeSwapVolumeFreeSpace(): Promise<void> {
  if (swapVolumeReadInFlight) {
    return
  }
  swapVolumeReadInFlight = true
  const generation = samplingGeneration
  const issuedFor = preGoneSample
  try {
    const volume = await readSwapVolumeFreeSpace()
    if (volume && preGoneSample && generation === samplingGeneration) {
      // Why only its own tick qualifies: a statfs that outlived its tick carries a
      // pre-storm volume number, and the latch makes that lag unbounded. It still
      // ships beside its age, but it may not decide the verdict.
      const coTimed = preGoneSample === issuedFor
      preGoneSample = {
        ...preGoneSample,
        details: withSwapVolumeFreeSpace(preGoneSample.details, volume, process.platform, coTimed),
        swapVolumeSampledAtMs: issuedFor?.sampledAtMs
      }
    }
  } catch {
    // Why: the memory reading is already committed and stands on its own.
  } finally {
    swapVolumeReadInFlight = false
  }
}

export async function samplePreGoneSystemMemory(nowMs: number = Date.now()): Promise<void> {
  // Why commit before awaiting: the volume read is a statfs, and under the very
  // paging storm this targets it is slowest — it must never delay, or (via an
  // in-flight latch) skip, the cheap synchronous host reading.
  if (!commitHostMemorySample(nowMs)) {
    return
  }
  await mergeSwapVolumeFreeSpace()
}

export function startPreGoneSystemMemorySampling(
  intervalMs: number = PRE_GONE_SYSTEM_MEMORY_SAMPLE_INTERVAL_MS
): void {
  if (preGoneTimer) {
    return
  }
  void samplePreGoneSystemMemory()
  preGoneTimer = setInterval(() => void samplePreGoneSystemMemory(), intervalMs)
  preGoneTimer.unref?.()
}

export function resetPreGoneSystemMemorySamplingForTest(): void {
  if (preGoneTimer) {
    clearInterval(preGoneTimer)
  }
  preGoneTimer = null
  preGoneSample = null
  swapVolumeReadInFlight = false
  // Why bump: an already-awaited volume read must not repopulate a reset sample.
  samplingGeneration += 1
}

/** Keyed as `systemMemoryPreGone*` so a scan over the `systemMemory` family sees both reads. */
export function preGoneSystemMemoryDetails(nowMs: number): CrashReportDetails {
  if (!preGoneSample) {
    return {}
  }
  const details: CrashReportDetails = {
    [`${SYSTEM_MEMORY_KEY_PREFIX}PreGoneSampleAgeMs`]: Math.max(
      0,
      nowMs - preGoneSample.sampledAtMs
    )
  }
  // Why its own age: the volume read resolves out of band, so it can be older
  // than the memory reading printed beside it, and that gap must be readable.
  if (preGoneSample.swapVolumeSampledAtMs !== undefined) {
    details[`${SYSTEM_MEMORY_KEY_PREFIX}PreGoneSwapVolumeAgeMs`] = Math.max(
      0,
      nowMs - preGoneSample.swapVolumeSampledAtMs
    )
  }
  for (const [key, value] of Object.entries(preGoneSample.details)) {
    details[`${SYSTEM_MEMORY_KEY_PREFIX}PreGone${key.slice(SYSTEM_MEMORY_KEY_PREFIX.length)}`] =
      value
  }
  return details
}
