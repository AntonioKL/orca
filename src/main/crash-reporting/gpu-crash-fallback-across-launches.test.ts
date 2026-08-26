import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  GpuCrashFallbackTracker
} from './gpu-crash-fallback-decision'
import {
  promptForGpuFallbackRestart,
  type GpuFallbackRestartDecision
} from './gpu-fallback-restart-prompt'
import { readActiveGpuCrashHistory, recordGpuCrashInHistory } from '../startup/gpu-crash-history'
import { GpuFallbackLaunchSession } from '../startup/gpu-fallback-launch-session'
import {
  GPU_FALLBACK_MARKER_FILE,
  writeGpuFallbackMarker,
  type WindowsGpuFallbackEnvironment
} from '../startup/gpu-fallback-marker'

vi.mock('./gpu-fallback-restart-prompt', () => ({ promptForGpuFallbackRestart: vi.fn() }))

/**
 * Regression for the 2026-08-16 Windows crash cluster (reports 1cf806c8,
 * 64e9f2a7, 8ae2b56f, af537a89, b566e1e0, e3e21dc6 — all 1.4.184 / Electron
 * 43.1.0 / Windows 10.0.26200).
 *
 * Field shape: the GPU child dies with STATUS_BREAKPOINT (-2147483645) ~580ms
 * after main_process_lifecycle_started and the launch is over. Across the six
 * diagnostics bundles every reconstructed launch recorded exactly ONE GPU crash
 * — never two, never three — so `GpuCrashFallbackTracker`, which needs
 * `threshold` crashes inside one process lifetime, could never fire and
 * gpu-fallback.json was structurally unwritable.
 *
 * The fix persists the evidence, so the rescue is driven across launches.
 */

const WINDOWS_ENVIRONMENT: WindowsGpuFallbackEnvironment = {
  appVersion: '1.4.184',
  electronVersion: '43.1.0',
  platform: 'win32'
}

// Offset of the GPU `process_gone_suppressed` breadcrumb from
// `main_process_lifecycle_started` in report 1cf806c8 (bundle fH9VHOQk).
const INCIDENT_GPU_CRASH_MS = 581
const MINUTE_MS = 60_000
const WEEK_MS = 7 * 24 * 60 * MINUTE_MS

type LaunchOutcome = {
  /** Did startup boot without hardware acceleration? */
  softwareRendering: boolean
  /** Crashes the in-process tracker held when this launch died. */
  crashesInWindow: number
  breadcrumbs: { name: string; data?: Record<string, unknown> }[]
  disableHardwareAccelerationCalls: number
  /** The launch's own session, so a test can drive the Settings exit the way the user does. */
  session: GpuFallbackLaunchSession
}

/**
 * One full app launch, wired exactly like index.ts: a fresh GpuFallbackLaunchSession decides
 * before whenReady, a fresh in-session tracker sees the same GPU deaths, and ready-to-show's
 * survival check resolves what this launch earned. Everything held in memory is gone when
 * this returns — which is the whole point of the defect it covers.
 */
function runLaunch(
  userDataPath: string,
  {
    launchId,
    nowEpochMs,
    crashAtMsSinceLaunch,
    inSessionCrashes = 1,
    inSessionPromptDecision = 'restart',
    survivesAMinutePastReadyToShow = false
  }: {
    launchId: string
    nowEpochMs: number
    crashAtMsSinceLaunch: number | null
    /** GPU deaths inside this one process; the in-session tracker only fires at 3. */
    inSessionCrashes?: number
    /** Answer to the in-session modal, once the tracker reaches its threshold. */
    inSessionPromptDecision?: GpuFallbackRestartDecision
    /** Chromium respawns a dead GPU child, so even a crashing launch can paint and live on. */
    survivesAMinutePastReadyToShow?: boolean
  }
): LaunchOutcome {
  const breadcrumbs: LaunchOutcome['breadcrumbs'] = []
  let disableHardwareAccelerationCalls = 0
  const session = new GpuFallbackLaunchSession({
    userDataPath,
    environment: WINDOWS_ENVIRONMENT,
    launchId,
    now: () => nowEpochMs,
    hooks: {
      disableHardwareAcceleration: () => {
        disableHardwareAccelerationCalls += 1
      },
      commandLine: { appendSwitch: () => {} },
      recordBreadcrumb: (name, data) => breadcrumbs.push({ name, data })
    }
  })
  session.engage()
  const tracker = new GpuCrashFallbackTracker({
    windowMs: DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
    threshold: DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD
  })
  let crashesInWindow = 0
  // Why the guard: software rendering leaves no GPU child, so it cannot die.
  if (!session.softwareRenderingActive && crashAtMsSinceLaunch !== null) {
    for (let crash = 0; crash < inSessionCrashes; crash += 1) {
      const msSinceLaunch = crashAtMsSinceLaunch + crash
      session.recordGpuCrash(msSinceLaunch)
      const result = tracker.recordGpuCrash(msSinceLaunch)
      crashesInWindow = result.crashesInWindow
      if (result.shouldEngageFallback && inSessionPromptDecision !== 'restart') {
        session.declineRestart()
        break
      }
    }
  }
  // index.ts arms this on ready-to-show and resolves it 60s later.
  if (survivesAMinutePastReadyToShow) {
    session.resolveHistoryReset()
  }
  return {
    softwareRendering: session.softwareRenderingActive,
    crashesInWindow,
    breadcrumbs,
    disableHardwareAccelerationCalls,
    session
  }
}

function runCrashingLaunch(userDataPath: string, index: number, startedAt: number): LaunchOutcome {
  return runLaunch(userDataPath, {
    launchId: `launch-${index}`,
    nowEpochMs: startedAt,
    crashAtMsSinceLaunch: INCIDENT_GPU_CRASH_MS
  })
}

describe('GPU crash fallback across app launches', () => {
  let userDataPath: string
  const startedAt = 1_760_000_000_000

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-gpu-fallback-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  // Why: the pinned [1,1,1,1,1,1] distribution from the six bundles IS the defect —
  // the in-session tracker is fed once per process and forgets. Any fix that still
  // needs a launch to reach two crashes is wrong for this failure mode.
  it('reproduces the field data: the in-session tracker tops out at one crash per launch', () => {
    const perLaunchCounts = Array.from({ length: 6 }, () => {
      const tracker = new GpuCrashFallbackTracker({
        windowMs: DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
        threshold: DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD
      })
      return tracker.recordGpuCrash(INCIDENT_GPU_CRASH_MS).crashesInWindow
    })

    expect(perLaunchCounts).toEqual([1, 1, 1, 1, 1, 1])
    expect(perLaunchCounts.some((count) => count >= DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD)).toBe(
      false
    )
  })

  it('engages software rendering on the launch after the third crash-at-startup', () => {
    const outcomes = Array.from({ length: 4 }, (_, index) =>
      runCrashingLaunch(userDataPath, index, startedAt + index * 10_000)
    )

    expect(outcomes.map((outcome) => outcome.softwareRendering)).toEqual([
      false,
      false,
      false,
      true
    ])
  })

  it('engages with no window: no restart prompt, marker written, breadcrumb emitted', () => {
    for (let index = 0; index < 3; index += 1) {
      runCrashingLaunch(userDataPath, index, startedAt + index * 10_000)
    }
    const rescue = runCrashingLaunch(userDataPath, 3, startedAt + 30_000)

    expect(rescue.disableHardwareAccelerationCalls).toBe(1)
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(true)
    expect(rescue.breadcrumbs).toEqual([
      {
        name: 'gpu_fallback_applied',
        data: {
          source: 'crash-history',
          crashesInWindow: 3,
          switches: 'disable-gpu,disable-software-rasterizer,in-process-gpu'
        }
      }
    ])
    // Why: this path runs before whenReady — there is no window to park a modal on.
    expect(promptForGpuFallbackRestart).not.toHaveBeenCalled()
  })

  it('stays in software rendering on later launches without re-deriving the decision', () => {
    for (let index = 0; index < 4; index += 1) {
      runCrashingLaunch(userDataPath, index, startedAt + index * 10_000)
    }
    const later = runCrashingLaunch(userDataPath, 4, startedAt + 40_000)

    expect(later.softwareRendering).toBe(true)
    expect(later.breadcrumbs[0]?.data?.source).toBe('marker')
  })

  // Why: the launch is the unit of evidence, so a launch that reached the window drops its own
  // entry and nothing else. Four launches that really did die before any window existed are four
  // dead launches inside ten minutes, whether or not a good one happened between them; the
  // wall-clock horizon is what stops evidence accumulating, not a passing launch's veto.
  it('does not let a launch that booted erase the launches that died at startup', () => {
    runCrashingLaunch(userDataPath, 0, startedAt)
    runCrashingLaunch(userDataPath, 1, startedAt + 10_000)
    runLaunch(userDataPath, {
      launchId: 'healthy',
      nowEpochMs: startedAt + 20_000,
      crashAtMsSinceLaunch: null,
      survivesAMinutePastReadyToShow: true
    })

    expect(
      readActiveGpuCrashHistory(userDataPath, WINDOWS_ENVIRONMENT).map((crash) => crash.launchId)
    ).toEqual(['launch-0', 'launch-1'])
    const outcomes = [
      runCrashingLaunch(userDataPath, 2, startedAt + 5 * MINUTE_MS),
      runCrashingLaunch(userDataPath, 3, startedAt + 6 * MINUTE_MS)
    ]

    expect(outcomes.map((outcome) => outcome.softwareRendering)).toEqual([false, true])
  })

  // Why: the modal promises "Keep Running leaves graphics settings unchanged", so the silent
  // cross-launch path must not impose on the next boot exactly what was just refused — for the
  // launch that raised it. The launches that died before any window existed were never on trial.
  it('does not override an explicit decline of the in-session prompt', () => {
    runCrashingLaunch(userDataPath, 0, startedAt)
    runCrashingLaunch(userDataPath, 1, startedAt + 10_000)
    const declined = runLaunch(userDataPath, {
      launchId: 'declined',
      nowEpochMs: startedAt + 20_000,
      crashAtMsSinceLaunch: INCIDENT_GPU_CRASH_MS,
      inSessionCrashes: DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
      inSessionPromptDecision: 'continue'
    })
    const next = runCrashingLaunch(userDataPath, 3, startedAt + 30_000)

    expect(declined.crashesInWindow).toBe(DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD)
    expect(next.softwareRendering).toBe(false)
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
    expect(
      readActiveGpuCrashHistory(userDataPath, WINDOWS_ENVIRONMENT).map((crash) => crash.launchId)
    ).toEqual(['launch-0', 'launch-1', 'launch-3'])
  })

  // Why: without a wall-clock horizon, ordinary background churn would eventually
  // fall a perfectly healthy machine back to software rendering.
  it('never accumulates: one crash a week for ten weeks must not engage', () => {
    for (let week = 0; week < 10; week += 1) {
      const outcome = runCrashingLaunch(userDataPath, week, startedAt + week * WEEK_MS)
      expect(outcome.softwareRendering).toBe(false)
    }

    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  // Why: a GPU-child-only death does not kill the renderer — Chromium respawns the child and
  // the window paints, so a launch that lived on is not evidence that Orca cannot boot. It
  // still may not erase the launches that died before any window existed.
  it('exonerates a launch that crashed the GPU and then painted, and only that launch', () => {
    runCrashingLaunch(userDataPath, 0, startedAt)
    runCrashingLaunch(userDataPath, 1, startedAt + 10_000)
    const painted = runLaunch(userDataPath, {
      launchId: 'crashed-then-painted',
      nowEpochMs: startedAt + 20_000,
      crashAtMsSinceLaunch: INCIDENT_GPU_CRASH_MS,
      survivesAMinutePastReadyToShow: true
    })
    expect(
      readActiveGpuCrashHistory(userDataPath, WINDOWS_ENVIRONMENT).map((crash) => crash.launchId)
    ).toEqual(['launch-0', 'launch-1'])

    // The painted launch no longer counts, so the rescue waits for a third launch that died.
    const third = runCrashingLaunch(userDataPath, 3, startedAt + 30_000)
    const rescue = runCrashingLaunch(userDataPath, 4, startedAt + 40_000)

    expect([painted.softwareRendering, third.softwareRendering]).toEqual([false, false])
    expect(rescue.softwareRendering).toBe(true)
  })

  // Why: a machine where Orca works fine but the GPU child blips once at startup must never be
  // downgraded — three restarts inside ten minutes (an update, a Restart button, a manual one)
  // is an ordinary morning.
  it('never engages for launches that blipped at startup and then ran on', () => {
    const outcomes = Array.from({ length: 4 }, (_, index) =>
      runLaunch(userDataPath, {
        launchId: `blip-${index}`,
        nowEpochMs: startedAt + index * MINUTE_MS,
        crashAtMsSinceLaunch: INCIDENT_GPU_CRASH_MS,
        survivesAMinutePastReadyToShow: true
      })
    )

    expect(outcomes.map((outcome) => outcome.softwareRendering)).toEqual([
      false,
      false,
      false,
      false
    ])
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  // Why: the modal fires on any three GPU deaths inside 30s, including a purely mid-session
  // burst that was never recorded as startup evidence. Declining answers for this launch only.
  it('keeps earlier startup evidence when a mid-session burst is declined', () => {
    runCrashingLaunch(userDataPath, 0, startedAt)
    runCrashingLaunch(userDataPath, 1, startedAt + 10_000)
    runLaunch(userDataPath, {
      launchId: 'mid-session-burst',
      nowEpochMs: startedAt + 20_000,
      crashAtMsSinceLaunch: 20 * MINUTE_MS,
      inSessionCrashes: DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
      inSessionPromptDecision: 'continue'
    })

    expect(
      readActiveGpuCrashHistory(userDataPath, WINDOWS_ENVIRONMENT).map((crash) => crash.launchId)
    ).toEqual(['launch-0', 'launch-1'])
  })

  // Why: version-scoped evidence dies with the update, so the full threshold would cost this
  // machine three unbootable launches after every release.
  it('re-engages after one crashing launch when the previous build had fallen back', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: startedAt - WEEK_MS, crashesInWindow: 3 },
      { ...WINDOWS_ENVIRONMENT, appVersion: '1.4.183' }
    )

    const fresh = runCrashingLaunch(userDataPath, 0, startedAt)
    const rescue = runCrashingLaunch(userDataPath, 1, startedAt + 10_000)

    expect(fresh.softwareRendering).toBe(false)
    expect(rescue.softwareRendering).toBe(true)
    expect(rescue.breadcrumbs[0]?.data?.source).toBe('crash-history-after-update')
  })

  // Why: nothing else ever expires that record — its reaper needs a launch that survives a
  // minute, which a machine used in short bursts never provides. A driver generation later it
  // would still be turning one spurious startup GPU death into a build-long downgrade.
  it('ignores a superseded-build record from months ago', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: startedAt - 13 * WEEK_MS, crashesInWindow: 3 },
      { ...WINDOWS_ENVIRONMENT, appVersion: '1.4.183' }
    )

    const spurious = runCrashingLaunch(userDataPath, 0, startedAt)
    const next = runCrashingLaunch(userDataPath, 1, startedAt + 10_000)

    expect([spurious.softwareRendering, next.softwareRendering]).toEqual([false, false])
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  // Why: the previous build's head start is spent the moment this build proves it boots.
  it('drops the previous build record once a launch boots cleanly', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: startedAt - WEEK_MS, crashesInWindow: 3 },
      { ...WINDOWS_ENVIRONMENT, appVersion: '1.4.183' }
    )
    runLaunch(userDataPath, {
      launchId: 'healthy-after-update',
      nowEpochMs: startedAt,
      crashAtMsSinceLaunch: null,
      survivesAMinutePastReadyToShow: true
    })

    const next = runCrashingLaunch(userDataPath, 1, startedAt + MINUTE_MS)

    expect(next.softwareRendering).toBe(false)
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  // Why: a single noisy launch must not evict the other launches that make up the threshold.
  it('survives a launch that emits a GPU crash loop', () => {
    runCrashingLaunch(userDataPath, 0, startedAt)
    for (let crash = 0; crash < 20; crash += 1) {
      recordGpuCrashInHistory(
        userDataPath,
        { atEpochMs: startedAt + 10_000 + crash, msSinceLaunch: 600 + crash, launchId: 'noisy' },
        WINDOWS_ENVIRONMENT
      )
    }
    runCrashingLaunch(userDataPath, 2, startedAt + 20_000)
    const rescue = runCrashingLaunch(userDataPath, 3, startedAt + 30_000)

    expect(rescue.softwareRendering).toBe(true)
  })

  // Why: a crash 20 minutes in is the in-session tracker's job (#10707), not evidence Orca cannot boot.
  it('ignores mid-session GPU crashes as cross-launch evidence', () => {
    for (let index = 0; index < 4; index += 1) {
      runLaunch(userDataPath, {
        launchId: `session-${index}`,
        nowEpochMs: startedAt + index * MINUTE_MS,
        crashAtMsSinceLaunch: 20 * MINUTE_MS
      })
    }

    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  // Why through setEnabled: this is the Settings switch, and turning it off has to drop the
  // evidence too — a marker cleared on its own is re-derived by the very next launch.
  it('exits software rendering once Settings turns Safe Graphics Mode off', () => {
    const launches = Array.from({ length: 4 }, (_, index) =>
      runCrashingLaunch(userDataPath, index, startedAt + index * 10_000)
    )
    launches[3].session.setEnabled(false)

    const retry = runLaunch(userDataPath, {
      launchId: 'retry',
      nowEpochMs: startedAt + 60_000,
      crashAtMsSinceLaunch: null
    })

    expect(retry.softwareRendering).toBe(false)
    expect(retry.disableHardwareAccelerationCalls).toBe(0)
  })
})
