import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import { getLiveSystemMemoryDetails, SYSTEM_MEMORY_KEY_PREFIX } from './system-memory-details'

// ─── Pre-gone host memory sampling ──────────────────────────────────
// Why a live sample at all: the gone-time host read lands after the corpse
// released its pages, so it reports a healthier machine than the one that
// refused the allocation.
// Why 10 s rather than the 60 s process-metrics cadence: the kill under
// investigation is a transient commit refusal, and at 60 s four of five field
// OOMs carried a ~37 s old host reading — far too stale to see it. One
// GlobalMemoryStatusEx-class call plus one statfs is cheap enough to poll this
// fast. A refusal shorter than the interval stays invisible; no cadence fixes that.

export const PRE_GONE_SYSTEM_MEMORY_SAMPLE_INTERVAL_MS = 10_000

type CrashReportDetails = Record<string, CrashReportDetailValue>

type PreGoneSystemMemorySample = {
  details: CrashReportDetails
  sampledAtMs: number
}

let preGoneSample: PreGoneSystemMemorySample | null = null
let preGoneTimer: ReturnType<typeof setInterval> | null = null
let sampleInFlight = false

export async function samplePreGoneSystemMemory(nowMs: number = Date.now()): Promise<void> {
  if (sampleInFlight) {
    return
  }
  sampleInFlight = true
  try {
    const details = await getLiveSystemMemoryDetails()
    if (Object.keys(details).length > 0) {
      preGoneSample = { details, sampledAtMs: nowMs }
    }
  } catch {
    // Why: a failed read must not erase the previous good sample.
  } finally {
    sampleInFlight = false
  }
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
  sampleInFlight = false
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
  for (const [key, value] of Object.entries(preGoneSample.details)) {
    details[`${SYSTEM_MEMORY_KEY_PREFIX}PreGone${key.slice(SYSTEM_MEMORY_KEY_PREFIX.length)}`] =
      value
  }
  return details
}
