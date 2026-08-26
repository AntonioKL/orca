import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFsModule from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GPU_CRASH_HISTORY_FILE,
  countStartupGpuCrashLaunches,
  forgetGpuCrashLaunch,
  readActiveGpuCrashHistory,
  recordGpuCrashInHistory
} from './gpu-crash-history'
import {
  GPU_FALLBACK_MARKER_FILE,
  readActiveGpuFallbackMarker,
  readGpuFallbackMarkerState,
  writeGpuFallbackMarker
} from './gpu-fallback-marker'

/**
 * What the two durable artifacts owe a filesystem that misbehaves.
 *
 * On the write side the marker is published by a process Chromium may FATAL milliseconds later,
 * and both callers drop the crash history the instant the write returns — a bare writeFileSync
 * could leave a torn marker (discarded as corrupt next launch) with the evidence already gone.
 *
 * On the read side a failure can say nothing about the contents: on Windows, Defender scanning
 * the file the publishing rename just created returns a sharing violation (EBUSY/EACCES).
 * Treating that as corruption and deleting the file resets the distinct-launch counter on
 * exactly the machine the cross-launch rescue exists to rescue.
 *
 * Both live here because both need the same node:fs seam, and splitting them mocks it twice.
 */

const calls = vi.hoisted(() => [] as string[])
const failRenameOnto = vi.hoisted(() => ({ path: null as string | null }))
const unreadablePaths = vi.hoisted(() => new Set<string>())

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsModule>()
  const writeFileSync = (...args: Parameters<typeof actual.writeFileSync>): void => {
    calls.push(`write:${String(args[0])}`)
    actual.writeFileSync(...args)
  }
  const fsyncSync = (...args: Parameters<typeof actual.fsyncSync>): void => {
    calls.push('fsync')
    actual.fsyncSync(...args)
  }
  const renameSync = (...args: Parameters<typeof actual.renameSync>): void => {
    calls.push(`rename:${String(args[1])}`)
    if (failRenameOnto.path !== null && args[1] === failRenameOnto.path) {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    }
    actual.renameSync(...args)
  }
  const readFileSync = (
    ...args: Parameters<typeof actual.readFileSync>
  ): ReturnType<typeof actual.readFileSync> => {
    if (typeof args[0] === 'string' && unreadablePaths.has(args[0])) {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    return actual.readFileSync(...args)
  }
  const patched = { writeFileSync, fsyncSync, renameSync, readFileSync }
  return { ...actual, ...patched, default: { ...actual, ...patched } }
})

const ENVIRONMENT = {
  appVersion: '1.4.184',
  electronVersion: '43.1.0',
  platform: 'win32' as const
}

const NOW = 1_760_000_000_000

describe('GPU fallback artifacts under filesystem failure', () => {
  let userDataPath: string
  let markerPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-gpu-artifact-io-'))
    markerPath = join(userDataPath, GPU_FALLBACK_MARKER_FILE)
    calls.length = 0
    failRenameOnto.path = null
    unreadablePaths.clear()
  })

  afterEach(() => {
    failRenameOnto.path = null
    unreadablePaths.clear()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('fsyncs a temp file and renames it onto the marker, never writing the marker in place', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: NOW, crashesInWindow: 3 }, ENVIRONMENT)

    expect(calls).not.toContain(`write:${markerPath}`)
    const tempWrite = calls.findIndex((call) => call.startsWith(`write:${markerPath}.`))
    const rename = calls.indexOf(`rename:${markerPath}`)
    expect(tempWrite).toBeGreaterThanOrEqual(0)
    expect(rename).toBeGreaterThan(tempWrite)
    expect(calls.slice(tempWrite, rename)).toContain('fsync')
    expect(readdirSync(userDataPath)).toEqual([GPU_FALLBACK_MARKER_FILE])
  })

  // Why: the temp name carries the pid, so a failure that left one behind would accumulate
  // orphans under distinct names forever on the machine that retries this write every launch.
  it('cleans up its temp file when the publishing rename fails', () => {
    failRenameOnto.path = markerPath

    expect(() =>
      writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 3 }, ENVIRONMENT)
    ).toThrow()
    expect(readdirSync(userDataPath)).toEqual([])
  })

  it('keeps a crash history it could not read, and the launches it counts', () => {
    for (const launchId of ['launch-0', 'launch-1']) {
      recordGpuCrashInHistory(
        userDataPath,
        { atEpochMs: NOW, msSinceLaunch: 581, launchId },
        ENVIRONMENT
      )
    }
    const path = join(userDataPath, GPU_CRASH_HISTORY_FILE)
    const intact = readFileSync(path, 'utf-8')
    unreadablePaths.add(path)

    expect(readActiveGpuCrashHistory(userDataPath, ENVIRONMENT)).toEqual([])
    // Why: publishing a one-entry file over evidence it could not read erases it just as surely.
    recordGpuCrashInHistory(
      userDataPath,
      { atEpochMs: NOW + 1_000, msSinceLaunch: 581, launchId: 'launch-2' },
      ENVIRONMENT
    )
    forgetGpuCrashLaunch(userDataPath, 'launch-0')
    unreadablePaths.clear()

    expect(readFileSync(path, 'utf-8')).toBe(intact)
    expect(
      countStartupGpuCrashLaunches(readActiveGpuCrashHistory(userDataPath, ENVIRONMENT), NOW)
    ).toBe(2)
  })

  // Why: deleting a marker this process merely failed to open restores the hardware launch the
  // machine already proved it cannot survive — silently, with no evidence left to re-derive it.
  it('keeps a marker it could not read', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: NOW, crashesInWindow: 3 }, ENVIRONMENT)
    const intact = readFileSync(markerPath, 'utf-8')
    unreadablePaths.add(markerPath)

    expect(readActiveGpuFallbackMarker(userDataPath, ENVIRONMENT, NOW)).toBeNull()
    unreadablePaths.clear()

    expect(readFileSync(markerPath, 'utf-8')).toBe(intact)
    expect(readGpuFallbackMarkerState(userDataPath, ENVIRONMENT, NOW).active?.crashesInWindow).toBe(
      3
    )
  })

  it('still discards a file that really is corrupt', () => {
    writeFileSync(join(userDataPath, GPU_CRASH_HISTORY_FILE), '{ "crashes": [')
    writeFileSync(markerPath, '{ not json')

    expect(readActiveGpuCrashHistory(userDataPath, ENVIRONMENT)).toEqual([])
    expect(readActiveGpuFallbackMarker(userDataPath, ENVIRONMENT, NOW)).toBeNull()
    expect(readdirSync(userDataPath)).toEqual([])
  })
})
