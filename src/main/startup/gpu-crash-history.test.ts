import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GPU_CRASH_HISTORY_FILE,
  GPU_CRASH_HISTORY_HORIZON_MS,
  GPU_CRASH_HISTORY_MAX_ENTRIES,
  GPU_CRASH_STARTUP_WINDOW_MS,
  clearGpuCrashHistory,
  countStartupGpuCrashLaunches,
  forgetGpuCrashLaunch,
  readActiveGpuCrashHistory,
  recordGpuCrashInHistory
} from './gpu-crash-history'
import type { WindowsGpuFallbackEnvironment } from './gpu-fallback-marker'

const ENVIRONMENT: WindowsGpuFallbackEnvironment = {
  appVersion: '1.4.184',
  electronVersion: '43.1.0',
  platform: 'win32'
}

const NOW = 1_760_000_000_000

describe('gpu-crash-history', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-gpu-crash-history-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('round-trips recorded crashes', () => {
    recordGpuCrashInHistory(
      userDataPath,
      { atEpochMs: NOW, msSinceLaunch: 581, launchId: 'launch-1' },
      ENVIRONMENT
    )
    recordGpuCrashInHistory(
      userDataPath,
      { atEpochMs: NOW + 5_000, msSinceLaunch: 604, launchId: 'launch-2' },
      ENVIRONMENT
    )

    expect(readActiveGpuCrashHistory(userDataPath, ENVIRONMENT)).toEqual([
      { atEpochMs: NOW, msSinceLaunch: 581, launchId: 'launch-1' },
      { atEpochMs: NOW + 5_000, msSinceLaunch: 604, launchId: 'launch-2' }
    ])
  })

  it('leaves no temp file behind after an atomic write', () => {
    recordGpuCrashInHistory(
      userDataPath,
      { atEpochMs: NOW, msSinceLaunch: 581, launchId: 'launch-1' },
      ENVIRONMENT
    )
    expect(readdirSync(userDataPath)).toEqual([GPU_CRASH_HISTORY_FILE])
  })

  it('caps the file at the newest entries', () => {
    for (let launch = 0; launch < GPU_CRASH_HISTORY_MAX_ENTRIES + 4; launch += 1) {
      recordGpuCrashInHistory(
        userDataPath,
        { atEpochMs: NOW + launch, msSinceLaunch: 581, launchId: `launch-${launch}` },
        ENVIRONMENT
      )
    }
    const crashes = readActiveGpuCrashHistory(userDataPath, ENVIRONMENT)

    expect(crashes).toHaveLength(GPU_CRASH_HISTORY_MAX_ENTRIES)
    expect(crashes.at(0)?.launchId).toBe('launch-4')
    expect(crashes.at(-1)?.launchId).toBe(`launch-${GPU_CRASH_HISTORY_MAX_ENTRIES + 3}`)
  })

  // Why: this parse runs before whenReady, so the cost must not depend on a file this code
  // never wrote — a foreign or hand-edited history cannot make the launch path do linear work.
  it('caps on read, not only on write', () => {
    writeFileSync(
      join(userDataPath, GPU_CRASH_HISTORY_FILE),
      JSON.stringify({
        schemeVersion: 1,
        appVersion: ENVIRONMENT.appVersion,
        electronVersion: ENVIRONMENT.electronVersion,
        platform: 'win32',
        crashes: Array.from({ length: 5_000 }, (_, launch) => ({
          atEpochMs: NOW + launch,
          msSinceLaunch: 581,
          launchId: `launch-${launch}`
        }))
      })
    )
    const crashes = readActiveGpuCrashHistory(userDataPath, ENVIRONMENT)

    expect(crashes).toHaveLength(GPU_CRASH_HISTORY_MAX_ENTRIES)
    expect(crashes.at(-1)?.launchId).toBe('launch-4999')
  })

  // Why: a driver in a respawn loop emits dozens of crashes under one launchId; if each
  // took a cap slot, one noisy launch would evict every other launch's evidence and the
  // distinct-launch counter could never reach its threshold.
  it('keeps one entry per launch so a crash loop cannot evict other launches', () => {
    recordGpuCrashInHistory(
      userDataPath,
      { atEpochMs: NOW, msSinceLaunch: 581, launchId: 'earlier' },
      ENVIRONMENT
    )
    for (let crash = 0; crash < GPU_CRASH_HISTORY_MAX_ENTRIES * 2; crash += 1) {
      recordGpuCrashInHistory(
        userDataPath,
        { atEpochMs: NOW + 1_000 + crash, msSinceLaunch: 600 + crash, launchId: 'noisy' },
        ENVIRONMENT
      )
    }
    const crashes = readActiveGpuCrashHistory(userDataPath, ENVIRONMENT)

    expect(crashes.map((crash) => crash.launchId)).toEqual(['earlier', 'noisy'])
    expect(countStartupGpuCrashLaunches(crashes, NOW + 2_000)).toBe(2)
  })

  // Why: a mid-session crash can never be counted, so letting it take a cap slot would
  // silently discard the startup evidence the cross-launch rescue runs on.
  it('never persists a crash that happened after startup', () => {
    recordGpuCrashInHistory(
      userDataPath,
      {
        atEpochMs: NOW,
        msSinceLaunch: GPU_CRASH_STARTUP_WINDOW_MS + 1,
        launchId: 'mid-session'
      },
      ENVIRONMENT
    )

    expect(existsSync(join(userDataPath, GPU_CRASH_HISTORY_FILE))).toBe(false)
  })

  it('prunes crashes beyond the wall-clock horizon when counting', () => {
    const crashes = [
      { atEpochMs: NOW - GPU_CRASH_HISTORY_HORIZON_MS - 1, msSinceLaunch: 581, launchId: 'old' },
      { atEpochMs: NOW - GPU_CRASH_HISTORY_HORIZON_MS, msSinceLaunch: 581, launchId: 'edge' },
      { atEpochMs: NOW - 1_000, msSinceLaunch: 581, launchId: 'recent' }
    ]

    expect(countStartupGpuCrashLaunches(crashes, NOW)).toBe(2)
  })

  // Why: atEpochMs is stamped ~600ms into boot, before W32Time fixes a wrong RTC; a
  // one-directional horizon would leave those entries valid for the whole build.
  it('prunes crashes stamped in the future by a clock that was later corrected', () => {
    const crashes = [
      { atEpochMs: NOW + GPU_CRASH_HISTORY_HORIZON_MS + 1, msSinceLaunch: 581, launchId: 'ahead' },
      { atEpochMs: NOW + 1_000, msSinceLaunch: 581, launchId: 'skewed-slightly' }
    ]

    expect(countStartupGpuCrashLaunches(crashes, NOW)).toBe(1)
  })

  it('counts each launch once no matter how many crashes it recorded', () => {
    const crashes = [
      { atEpochMs: NOW, msSinceLaunch: 581, launchId: 'launch-1' },
      { atEpochMs: NOW + 20, msSinceLaunch: 601, launchId: 'launch-1' },
      { atEpochMs: NOW + 40, msSinceLaunch: 621, launchId: 'launch-1' }
    ]

    expect(countStartupGpuCrashLaunches(crashes, NOW + 100)).toBe(1)
  })

  // Why: a mid-session GPU crash is the in-session tracker's job; feeding it to a
  // counter that means "cannot even boot" would fall back a perfectly bootable app.
  it('ignores crashes that happened after startup', () => {
    const crashes = [
      { atEpochMs: NOW, msSinceLaunch: GPU_CRASH_STARTUP_WINDOW_MS, launchId: 'startup' },
      { atEpochMs: NOW, msSinceLaunch: GPU_CRASH_STARTUP_WINDOW_MS + 1, launchId: 'mid-session' },
      { atEpochMs: NOW, msSinceLaunch: 920_000, launchId: 'much-later' }
    ]

    expect(countStartupGpuCrashLaunches(crashes, NOW)).toBe(1)
  })

  it('discards history written by a different app version', () => {
    recordGpuCrashInHistory(
      userDataPath,
      { atEpochMs: NOW, msSinceLaunch: 581, launchId: 'launch-1' },
      ENVIRONMENT
    )

    expect(
      readActiveGpuCrashHistory(userDataPath, { ...ENVIRONMENT, appVersion: '1.4.185' })
    ).toEqual([])
    expect(existsSync(join(userDataPath, GPU_CRASH_HISTORY_FILE))).toBe(false)
  })

  // Why: an Electron bump replaces the whole GPU stack, so its crash evidence says nothing about the new one.
  it('discards history written by a different Electron version', () => {
    recordGpuCrashInHistory(
      userDataPath,
      { atEpochMs: NOW, msSinceLaunch: 581, launchId: 'launch-1' },
      ENVIRONMENT
    )

    expect(
      readActiveGpuCrashHistory(userDataPath, { ...ENVIRONMENT, electronVersion: '44.0.0' })
    ).toEqual([])
    expect(existsSync(join(userDataPath, GPU_CRASH_HISTORY_FILE))).toBe(false)
  })

  it('discards history off Windows', () => {
    recordGpuCrashInHistory(
      userDataPath,
      { atEpochMs: NOW, msSinceLaunch: 581, launchId: 'launch-1' },
      ENVIRONMENT
    )

    expect(readActiveGpuCrashHistory(userDataPath, { ...ENVIRONMENT, platform: 'darwin' })).toEqual(
      []
    )
    expect(existsSync(join(userDataPath, GPU_CRASH_HISTORY_FILE))).toBe(false)
  })

  it('treats a missing or corrupt file as empty history', () => {
    expect(readActiveGpuCrashHistory(userDataPath, ENVIRONMENT)).toEqual([])

    writeFileSync(join(userDataPath, GPU_CRASH_HISTORY_FILE), '{ "crashes": [')
    expect(readActiveGpuCrashHistory(userDataPath, ENVIRONMENT)).toEqual([])
    expect(existsSync(join(userDataPath, GPU_CRASH_HISTORY_FILE))).toBe(false)

    writeFileSync(
      join(userDataPath, GPU_CRASH_HISTORY_FILE),
      JSON.stringify({ schemeVersion: 999, crashes: [] })
    )
    expect(readActiveGpuCrashHistory(userDataPath, ENVIRONMENT)).toEqual([])
    expect(existsSync(join(userDataPath, GPU_CRASH_HISTORY_FILE))).toBe(false)
  })

  it('drops individual malformed entries but keeps the readable ones', () => {
    writeFileSync(
      join(userDataPath, GPU_CRASH_HISTORY_FILE),
      JSON.stringify({
        schemeVersion: 1,
        ...ENVIRONMENT,
        crashes: [
          { atEpochMs: NOW, msSinceLaunch: 581, launchId: 'good' },
          { atEpochMs: 'nope', msSinceLaunch: 581, launchId: 'bad-time' },
          { atEpochMs: NOW, msSinceLaunch: -1, launchId: 'negative' },
          { atEpochMs: NOW, msSinceLaunch: 581, launchId: '' },
          null
        ]
      })
    )

    expect(readActiveGpuCrashHistory(userDataPath, ENVIRONMENT)).toEqual([
      { atEpochMs: NOW, msSinceLaunch: 581, launchId: 'good' }
    ])
  })

  // Why: a launch answers only for itself — it painted a window, or the user declined the
  // prompt it raised. The launches that died before any window existed are not its to erase.
  it('forgets one launch and keeps every other launch', () => {
    for (const launchId of ['launch-1', 'launch-2', 'launch-3']) {
      recordGpuCrashInHistory(
        userDataPath,
        { atEpochMs: NOW, msSinceLaunch: 581, launchId },
        ENVIRONMENT
      )
    }

    forgetGpuCrashLaunch(userDataPath, 'launch-2')

    expect(readActiveGpuCrashHistory(userDataPath, ENVIRONMENT).map((c) => c.launchId)).toEqual([
      'launch-1',
      'launch-3'
    ])
  })

  it('removes the file once the last remembered launch is forgotten', () => {
    recordGpuCrashInHistory(
      userDataPath,
      { atEpochMs: NOW, msSinceLaunch: 581, launchId: 'only' },
      ENVIRONMENT
    )

    forgetGpuCrashLaunch(userDataPath, 'only')

    expect(existsSync(join(userDataPath, GPU_CRASH_HISTORY_FILE))).toBe(false)
  })

  it('ignores a launch it never recorded, with or without a history file', () => {
    expect(() => forgetGpuCrashLaunch(userDataPath, 'never-seen')).not.toThrow()
    recordGpuCrashInHistory(
      userDataPath,
      { atEpochMs: NOW, msSinceLaunch: 581, launchId: 'kept' },
      ENVIRONMENT
    )

    forgetGpuCrashLaunch(userDataPath, 'never-seen')

    expect(readActiveGpuCrashHistory(userDataPath, ENVIRONMENT)).toHaveLength(1)
  })

  it('can explicitly clear the history', () => {
    recordGpuCrashInHistory(
      userDataPath,
      { atEpochMs: NOW, msSinceLaunch: 581, launchId: 'launch-1' },
      ENVIRONMENT
    )
    clearGpuCrashHistory(userDataPath)

    expect(existsSync(join(userDataPath, GPU_CRASH_HISTORY_FILE))).toBe(false)
    expect(readActiveGpuCrashHistory(userDataPath, ENVIRONMENT)).toEqual([])
  })
})
