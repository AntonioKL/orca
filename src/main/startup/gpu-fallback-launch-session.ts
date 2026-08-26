import { join } from 'node:path'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import type { GpuFallbackStatus } from '../../shared/gpu-fallback-status'
import { removeStaleDurableWriteTempFiles } from '../durable-file-write'
import {
  GPU_CRASH_HISTORY_FILE,
  GPU_CRASH_STARTUP_WINDOW_MS,
  clearGpuCrashHistory,
  forgetGpuCrashLaunch,
  readActiveGpuCrashHistory,
  recordGpuCrashInHistory
} from './gpu-crash-history'
import {
  decideGpuFallbackForLaunch,
  resolveGpuCrashHistoryReset,
  type GpuFallbackLaunchDecision
} from './gpu-fallback-launch-decision'
import {
  GPU_FALLBACK_MARKER_FILE,
  clearGpuFallbackMarker,
  clearSupersededGpuFallbackMarker,
  readActiveGpuFallbackMarker,
  readGpuFallbackMarkerState,
  writeGpuFallbackMarker,
  type GpuFallbackEnvironment,
  type WindowsGpuFallbackEnvironment
} from './gpu-fallback-marker'
import {
  applyGpuFallbackCommandLineSwitches,
  type GpuFallbackCommandLine
} from './gpu-fallback-switches'

/** Survive this long past the painted window and the launch has proved it boots. */
export const GPU_CRASH_HISTORY_RESET_DELAY_MS = 60_000

/** Spares another instance's in-flight write; nothing this old can still be mid-rename. */
const ORPHANED_TEMP_MIN_AGE_MS = 600_000

export type GpuFallbackLaunchHooks = {
  /** app.disableHardwareAcceleration — must run before app.whenReady() resolves. */
  disableHardwareAcceleration: () => void
  commandLine: GpuFallbackCommandLine
  recordBreadcrumb: (name: string, data?: CrashReportBreadcrumbData) => void
}

/** Temp names carry the pid, so a FATAL between write and rename orphans one per launch forever. */
export function sweepOrphanedGpuFallbackWrites(userDataPath: string): void {
  for (const file of [GPU_FALLBACK_MARKER_FILE, GPU_CRASH_HISTORY_FILE]) {
    void removeStaleDurableWriteTempFiles(join(userDataPath, file), {
      minimumAgeMs: ORPHANED_TEMP_MIN_AGE_MS
    }).catch(() => {
      // best effort; an orphaned temp file costs a few bytes
    })
  }
}

/**
 * Everything one app launch does about software rendering.
 *
 * Why an object and not flags in index.ts: the state is per-launch by nature, every durable
 * read and write derives from the one `userDataPath` captured here, and a test can construct
 * one per simulated launch instead of re-implementing index.ts's wiring and hoping it matches.
 */
export class GpuFallbackLaunchSession {
  private readonly userDataPath: string
  private readonly environment: GpuFallbackEnvironment
  private readonly launchId: string
  private readonly hooks: GpuFallbackLaunchHooks
  private readonly now: () => number
  private active = false
  private engagedAt: number | null = null
  /** The user answered the in-session prompt with "no"; nothing recorded may override that. */
  private declined = false
  /** Scoped to the startup window: a GPU death 20 minutes in is the in-session tracker's business. */
  private crashedDuringStartup = false
  private resetTimer: NodeJS.Timeout | null = null

  constructor(options: {
    userDataPath: string
    environment: GpuFallbackEnvironment
    launchId: string
    hooks: GpuFallbackLaunchHooks
    now?: () => number
  }) {
    this.userDataPath = options.userDataPath
    this.environment = options.environment
    this.launchId = options.launchId
    this.hooks = options.hooks
    this.now = options.now ?? Date.now
  }

  /** True when this launch booted without hardware acceleration. */
  get softwareRenderingActive(): boolean {
    return this.active
  }

  /**
   * Decides and applies software rendering for this launch. Runs before whenReady, so there is
   * no window to prompt on: this engages *silently* and the renderer notice explains it after
   * the fact. The in-session prompt path stays as-is — it is correct because the app can ask.
   */
  engage(): GpuFallbackLaunchDecision {
    const nowEpochMs = this.now()
    const markerState = readGpuFallbackMarkerState(this.userDataPath, this.environment, nowEpochMs)
    const decision = decideGpuFallbackForLaunch({
      marker: markerState.active,
      supersededBuildMarker: markerState.supersededBuild,
      history: readActiveGpuCrashHistory(this.userDataPath, this.environment),
      nowEpochMs,
      environment: this.environment
    })
    if (!decision.engage) {
      return decision
    }
    this.active = true
    this.engagedAt = decision.engagedAt
    this.hooks.disableHardwareAcceleration()
    const appliedSwitches = applyGpuFallbackCommandLineSwitches(
      this.hooks.commandLine,
      this.environment.platform
    )
    if (decision.reason !== 'marker') {
      // Why a failure is tolerated: this runs before whenReady, and a userData EPERM must not
      // turn a graphics workaround into a startup crash. The history re-derives the decision.
      this.promoteToMarker(decision.crashesInWindow, nowEpochMs)
    }
    // Why: with no GPU child left, child-process-gone can't report a GPU fault, so
    // name the applied switches in the trail any later crash report carries.
    this.hooks.recordBreadcrumb('gpu_fallback_applied', {
      source: decision.reason,
      crashesInWindow: decision.crashesInWindow,
      switches: appliedSwitches.join(',')
    })
    return decision
  }

  /** Crash-at-startup kills this process before the in-session tracker reaches its threshold. */
  recordGpuCrash(msSinceLaunch: number): void {
    this.crashedDuringStartup ||= msSinceLaunch <= GPU_CRASH_STARTUP_WINDOW_MS
    const environment = this.windowsEnvironment()
    if (!environment || this.declined) {
      return
    }
    try {
      recordGpuCrashInHistory(
        this.userDataPath,
        { atEpochMs: this.now(), msSinceLaunch, launchId: this.launchId },
        environment
      )
    } catch (error) {
      console.warn('[gpu-fallback] failed to persist crash history:', error)
    }
  }

  /**
   * The prompt promised "leaves graphics settings unchanged", so the silent cross-launch path
   * may not impose what was just refused. Scoped to this launch: the prompt also fires on a
   * purely mid-session burst, which is no verdict on launches that died before any window.
   */
  declineRestart(): void {
    this.declined = true
    this.forgetThisLaunch()
  }

  /** Promotes crash evidence to the sticky decision. False if the marker could not be written. */
  promoteToMarker(crashesInWindow: number, engagedAt: number): boolean {
    return this.writeMarker({ engagedAt, crashesInWindow })
  }

  /**
   * Arms the survival check. What surviving proves is resolved when the timer fires, not when
   * it is armed, so a GPU death in between narrows the reset instead of vetoing it. Armed even
   * in software rendering, because the timer also carries the orphan sweep — a readdir with
   * nothing urgent in it has no business on the ready-to-show path.
   */
  armHistoryReset(): void {
    if (this.resetTimer) {
      return
    }
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null
      sweepOrphanedGpuFallbackWrites(this.userDataPath)
      this.resolveHistoryReset()
    }, GPU_CRASH_HISTORY_RESET_DELAY_MS)
    this.resetTimer.unref?.()
  }

  cancelHistoryReset(): void {
    if (!this.resetTimer) {
      return
    }
    clearTimeout(this.resetTimer)
    this.resetTimer = null
  }

  /** What the armed timer runs: spends whatever a launch that survived has earned. */
  resolveHistoryReset(): void {
    const reset = resolveGpuCrashHistoryReset({
      gpuCrashedDuringStartup: this.crashedDuringStartup,
      gpuFallbackActive: this.active
    })
    if (reset.forgetThisLaunch) {
      this.forgetThisLaunch()
    }
    const environment = this.windowsEnvironment()
    if (reset.clearSupersededMarker && environment) {
      try {
        clearSupersededGpuFallbackMarker(this.userDataPath, environment, this.now())
      } catch (error) {
        console.warn('[gpu-fallback] failed to clear the superseded-build marker:', error)
      }
    }
  }

  status(): GpuFallbackStatus {
    const marker = this.windowsEnvironment()
      ? readActiveGpuFallbackMarker(this.userDataPath, this.environment, this.now())
      : null
    return {
      active: this.active,
      engagedAt: this.engagedAt,
      enabledForNextLaunch: marker !== null,
      // Why: the marker is the standing decision. An active launch with no marker only happens
      // when the automatic write failed, which is never a pin — so it cannot be reported as one.
      source: marker?.source ?? (this.active ? 'automatic' : null)
    }
  }

  /**
   * Settings' on/off for Safe Graphics Mode; the caller relaunches to apply it. A user-sourced
   * marker outlives updates, unlike the automatic one. Turning it off drops both artifacts, or
   * the leftover evidence re-engages on the very next launch.
   */
  setEnabled(enabled: boolean): void {
    if (!this.windowsEnvironment()) {
      return
    }
    this.cancelHistoryReset()
    if (!enabled) {
      clearGpuFallbackMarker(this.userDataPath)
      clearGpuCrashHistory(this.userDataPath)
      this.hooks.recordBreadcrumb('gpu_fallback_cleared')
      return
    }
    this.writeMarker({ engagedAt: this.now(), crashesInWindow: 0, source: 'user' })
    this.hooks.recordBreadcrumb('gpu_fallback_pinned')
  }

  private writeMarker(info: Parameters<typeof writeGpuFallbackMarker>[1]): boolean {
    const environment = this.windowsEnvironment()
    if (!environment) {
      return false
    }
    try {
      writeGpuFallbackMarker(this.userDataPath, info, environment)
    } catch (error) {
      console.warn('[gpu-fallback] failed to persist marker:', error)
      return false
    }
    // Why: the evidence is spent once it becomes a decision — leaving it would re-engage
    // immediately after the user asks for hardware acceleration back.
    clearGpuCrashHistory(this.userDataPath)
    return true
  }

  private forgetThisLaunch(): void {
    try {
      forgetGpuCrashLaunch(this.userDataPath, this.launchId)
    } catch (error) {
      console.warn('[gpu-fallback] failed to drop this launch from the crash history:', error)
    }
  }

  private windowsEnvironment(): WindowsGpuFallbackEnvironment | null {
    return this.environment.platform === 'win32' ? { ...this.environment, platform: 'win32' } : null
  }
}
