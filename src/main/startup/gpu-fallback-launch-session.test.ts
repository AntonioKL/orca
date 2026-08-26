import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GPU_CRASH_HISTORY_FILE,
  GPU_CRASH_STARTUP_WINDOW_MS,
  readActiveGpuCrashHistory
} from './gpu-crash-history'
import {
  GPU_CRASH_HISTORY_RESET_DELAY_MS,
  GpuFallbackLaunchSession,
  sweepOrphanedGpuFallbackWrites
} from './gpu-fallback-launch-session'
import {
  GPU_FALLBACK_MARKER_FILE,
  readGpuFallbackMarker,
  writeGpuFallbackMarker,
  type GpuFallbackEnvironment
} from './gpu-fallback-marker'

const WINDOWS_ENVIRONMENT: GpuFallbackEnvironment = {
  appVersion: '1.4.184',
  electronVersion: '43.1.0',
  platform: 'win32'
}

const NOW = 1_760_000_000_000

function createSession(
  userDataPath: string,
  overrides: { environment?: GpuFallbackEnvironment; launchId?: string } = {}
): { session: GpuFallbackLaunchSession; breadcrumbs: string[] } {
  const breadcrumbs: string[] = []
  const session = new GpuFallbackLaunchSession({
    userDataPath,
    environment: overrides.environment ?? WINDOWS_ENVIRONMENT,
    launchId: overrides.launchId ?? 'launch-1',
    now: () => NOW,
    hooks: {
      disableHardwareAcceleration: () => {},
      commandLine: { appendSwitch: () => {} },
      recordBreadcrumb: (name) => breadcrumbs.push(name)
    }
  })
  return { session, breadcrumbs }
}

describe('GpuFallbackLaunchSession', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-gpu-session-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  // Why: a driver that dies 20 minutes in is the in-session tracker's business. Feeding it to a
  // counter that means "cannot even boot" is what would let an ordinary TDR pin software rendering.
  it('records a startup GPU death as evidence and a late one as nothing', () => {
    const { session } = createSession(userDataPath)

    session.recordGpuCrash(GPU_CRASH_STARTUP_WINDOW_MS + 1)

    expect(readActiveGpuCrashHistory(userDataPath, WINDOWS_ENVIRONMENT)).toEqual([])

    session.recordGpuCrash(581)

    expect(readActiveGpuCrashHistory(userDataPath, WINDOWS_ENVIRONMENT)).toEqual([
      { atEpochMs: NOW, msSinceLaunch: 581, launchId: 'launch-1' }
    ])
  })

  // Why: a launch that reached a painted window and lived answers for itself only, and the
  // proof is resolved when the timer fires — a GPU death in between narrows it, never vetoes it.
  it('forgets this launch only after the armed survival timer fires', () => {
    vi.useFakeTimers()
    const { session } = createSession(userDataPath)
    session.recordGpuCrash(581)
    session.armHistoryReset()
    // Why: re-arming on a second ready-to-show must not restart the clock.
    session.armHistoryReset()

    vi.advanceTimersByTime(GPU_CRASH_HISTORY_RESET_DELAY_MS - 1)

    expect(readActiveGpuCrashHistory(userDataPath, WINDOWS_ENVIRONMENT)).toHaveLength(1)

    vi.advanceTimersByTime(1)

    expect(readActiveGpuCrashHistory(userDataPath, WINDOWS_ENVIRONMENT)).toEqual([])
  })

  it('cancels the armed survival timer', () => {
    vi.useFakeTimers()
    const { session } = createSession(userDataPath)
    session.recordGpuCrash(581)
    session.armHistoryReset()
    session.cancelHistoryReset()

    vi.advanceTimersByTime(GPU_CRASH_HISTORY_RESET_DELAY_MS * 2)

    expect(readActiveGpuCrashHistory(userDataPath, WINDOWS_ENVIRONMENT)).toHaveLength(1)
  })

  // Why: the pin is the user's standing choice, so it must outlive the evidence — and dropping
  // the evidence is what stops the automatic path re-engaging the moment the pin is removed.
  it('pins and clears Safe Graphics Mode, taking the evidence with it', () => {
    const { session, breadcrumbs } = createSession(userDataPath)
    session.recordGpuCrash(581)

    session.setEnabled(true)

    expect(readGpuFallbackMarker(userDataPath)?.source).toBe('user')
    expect(readActiveGpuCrashHistory(userDataPath, WINDOWS_ENVIRONMENT)).toEqual([])
    expect(session.status().enabledForNextLaunch).toBe(true)

    session.setEnabled(false)

    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
    expect(session.status()).toEqual({
      active: false,
      engagedAt: null,
      enabledForNextLaunch: false,
      source: null
    })
    expect(breadcrumbs).toEqual(['gpu_fallback_pinned', 'gpu_fallback_cleared'])
  })

  it('does nothing durable off the Windows desktop', () => {
    const { session } = createSession(userDataPath, {
      environment: { ...WINDOWS_ENVIRONMENT, platform: 'darwin' }
    })

    session.engage()
    session.recordGpuCrash(581)
    session.setEnabled(true)

    expect(session.softwareRenderingActive).toBe(false)
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
    expect(existsSync(join(userDataPath, GPU_CRASH_HISTORY_FILE))).toBe(false)
  })

  // Why one sweep for both artifacts: a FATAL between write and rename is routine on exactly
  // this machine class, and the temp name carries the pid, so orphans pile up under distinct
  // names forever. Both files are written on the same paths, so both need reclaiming.
  it('sweeps temp files orphaned by an earlier process, for both artifacts', async () => {
    const orphans = [GPU_FALLBACK_MARKER_FILE, GPU_CRASH_HISTORY_FILE].map((file) => {
      const orphan = join(userDataPath, `${file}.999999.1.abc.tmp`)
      writeFileSync(orphan, '{}')
      const staleSeconds = (Date.now() - 24 * 60 * 60 * 1000) / 1000
      utimesSync(orphan, staleSeconds, staleSeconds)
      return orphan
    })
    // Why kept: this is the live marker, not a temp — a sweep that took it would restore the
    // hardware launch the machine already proved it cannot survive.
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: NOW, crashesInWindow: 3 },
      { ...WINDOWS_ENVIRONMENT, platform: 'win32' }
    )

    sweepOrphanedGpuFallbackWrites(userDataPath)

    await vi.waitFor(() => {
      expect(orphans.map(existsSync)).toEqual([false, false])
    })
    expect(readGpuFallbackMarker(userDataPath)).not.toBeNull()
  })
})
