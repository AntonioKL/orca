import { describe, expect, it } from 'vitest'
import {
  CROSS_LAUNCH_GPU_FALLBACK_THRESHOLD,
  GPU_CRASH_HISTORY_HORIZON_MS,
  type GpuCrashHistoryEntry
} from './gpu-crash-history'
import {
  decideGpuFallbackForLaunch,
  resolveGpuCrashHistoryReset
} from './gpu-fallback-launch-decision'
import type { GpuFallbackEnvironment, GpuFallbackMarker } from './gpu-fallback-marker'

const NOW = 1_760_000_000_000

const ENVIRONMENT: GpuFallbackEnvironment = {
  appVersion: '1.4.184',
  electronVersion: '43.1.0',
  platform: 'win32'
}

const MARKER: GpuFallbackMarker = {
  schemeVersion: 2,
  engagedAt: NOW - 1_000,
  crashesInWindow: 3,
  appVersion: '1.4.184',
  electronVersion: '43.1.0',
  platform: 'win32',
  source: 'automatic'
}

function crashingLaunches(count: number, atEpochMs = NOW - 1_000): GpuCrashHistoryEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    atEpochMs,
    msSinceLaunch: 581,
    launchId: `launch-${index}`
  }))
}

describe('decideGpuFallbackForLaunch', () => {
  it('does not engage without evidence', () => {
    expect(
      decideGpuFallbackForLaunch({
        marker: null,
        history: [],
        nowEpochMs: NOW,
        environment: ENVIRONMENT
      })
    ).toEqual({ engage: false, reason: 'no-evidence', crashesInWindow: 0, engagedAt: null })
  })

  it('engages from an existing marker without re-deriving', () => {
    expect(
      decideGpuFallbackForLaunch({
        marker: MARKER,
        history: crashingLaunches(1),
        nowEpochMs: NOW,
        environment: ENVIRONMENT
      })
    ).toEqual({
      engage: true,
      reason: 'marker',
      crashesInWindow: 3,
      engagedAt: MARKER.engagedAt
    })
  })

  it('engages once enough distinct launches crashed at startup', () => {
    expect(
      decideGpuFallbackForLaunch({
        marker: null,
        history: crashingLaunches(CROSS_LAUNCH_GPU_FALLBACK_THRESHOLD),
        nowEpochMs: NOW,
        environment: ENVIRONMENT
      })
    ).toEqual({
      engage: true,
      reason: 'crash-history',
      crashesInWindow: CROSS_LAUNCH_GPU_FALLBACK_THRESHOLD,
      engagedAt: NOW
    })
  })

  it('holds below the threshold', () => {
    expect(
      decideGpuFallbackForLaunch({
        marker: null,
        history: crashingLaunches(CROSS_LAUNCH_GPU_FALLBACK_THRESHOLD - 1),
        nowEpochMs: NOW,
        environment: ENVIRONMENT
      }).engage
    ).toBe(false)
  })

  it('ignores evidence past the wall-clock horizon', () => {
    expect(
      decideGpuFallbackForLaunch({
        marker: null,
        history: crashingLaunches(
          CROSS_LAUNCH_GPU_FALLBACK_THRESHOLD,
          NOW - GPU_CRASH_HISTORY_HORIZON_MS - 1
        ),
        nowEpochMs: NOW,
        environment: ENVIRONMENT
      })
    ).toEqual({ engage: false, reason: 'no-evidence', crashesInWindow: 0, engagedAt: null })
  })

  // Why: enableMainProcessGpuFeatures() carries the macOS Graphite fix and is skipped while
  // fallback is active, so this must never engage off Windows.
  it('never engages off Windows', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(
        decideGpuFallbackForLaunch({
          marker: MARKER,
          history: crashingLaunches(CROSS_LAUNCH_GPU_FALLBACK_THRESHOLD),
          nowEpochMs: NOW,
          environment: { ...ENVIRONMENT, platform }
        })
      ).toEqual({
        engage: false,
        reason: 'unsupported-platform',
        crashesInWindow: 0,
        engagedAt: null
      })
    }
  })
})

describe('post-update threshold', () => {
  // Why: the previous build's evidence dies with the update, so the full threshold would cost
  // a machine that cannot boot three unusable launches after every release.
  it('re-engages after a single crashing launch when a previous build had fallen back', () => {
    expect(
      decideGpuFallbackForLaunch({
        marker: null,
        supersededBuildMarker: { ...MARKER, appVersion: '1.4.183' },
        history: crashingLaunches(1),
        nowEpochMs: NOW,
        environment: ENVIRONMENT
      })
    ).toEqual({
      engage: true,
      reason: 'crash-history-after-update',
      crashesInWindow: 1,
      engagedAt: NOW
    })
  })

  // Why: the update may be the fix, so the new build still gets one hardware attempt.
  it('still gives the new build one fresh hardware attempt', () => {
    expect(
      decideGpuFallbackForLaunch({
        marker: null,
        supersededBuildMarker: { ...MARKER, appVersion: '1.4.183' },
        history: [],
        nowEpochMs: NOW,
        environment: ENVIRONMENT
      }).engage
    ).toBe(false)
  })
})

describe('resolveGpuCrashHistoryReset', () => {
  // Why: a clean boot spends the previous build's lowered threshold, but the history is still
  // only ever touched one launchId at a time — other launches' evidence is not this one's to drop.
  it('forgets only this launch when it painted with no startup GPU death', () => {
    expect(
      resolveGpuCrashHistoryReset({ gpuCrashedDuringStartup: false, gpuFallbackActive: false })
    ).toEqual({ forgetThisLaunch: true, clearSupersededMarker: true })
  })

  // Why: Chromium respawns the dead child and the window paints anyway, so this launch is not
  // "cannot even boot" — but the child is still dying, so the update keeps its head start.
  it('exonerates the launch whose GPU child died during startup without spending the head start', () => {
    expect(
      resolveGpuCrashHistoryReset({ gpuCrashedDuringStartup: true, gpuFallbackActive: false })
    ).toEqual({ forgetThisLaunch: true, clearSupersededMarker: false })
  })

  // Why: `in-process-gpu` leaves no GPU child to die, so surviving proves nothing about the
  // driver — and if the marker write failed, the history is the only thing keeping fallback on.
  it('proves nothing when the launch only booted because software rendering was on', () => {
    expect(
      resolveGpuCrashHistoryReset({ gpuCrashedDuringStartup: false, gpuFallbackActive: true })
    ).toEqual({ forgetThisLaunch: false, clearSupersededMarker: false })
  })
})
