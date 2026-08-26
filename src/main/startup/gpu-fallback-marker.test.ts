import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GPU_FALLBACK_MARKER_FILE,
  GPU_FALLBACK_SUPERSEDED_MARKER_MAX_AGE_MS,
  clearGpuFallbackMarker,
  clearSupersededGpuFallbackMarker,
  readActiveGpuFallbackMarker,
  readGpuFallbackMarker,
  readGpuFallbackMarkerState,
  writeGpuFallbackMarker
} from './gpu-fallback-marker'

const NOW = 1_760_000_000_000

describe('gpu-fallback-marker', () => {
  let userDataPath: string
  const environment = {
    appVersion: '1.2.3',
    electronVersion: '42.3.3',
    platform: 'win32' as const
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-gpu-fallback-test-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('round-trips a written marker', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 123, crashesInWindow: 3 }, environment)
    expect(readGpuFallbackMarker(userDataPath)).toEqual({
      schemeVersion: 2,
      engagedAt: 123,
      crashesInWindow: 3,
      appVersion: '1.2.3',
      electronVersion: '42.3.3',
      platform: 'win32',
      source: 'automatic'
    })
  })

  // Why: markers predate the Settings pin, so a missing source is not corruption.
  it('reads a marker written before the source field existed as automatic', () => {
    writeFileSync(
      join(userDataPath, GPU_FALLBACK_MARKER_FILE),
      JSON.stringify({
        schemeVersion: 2,
        engagedAt: 1,
        crashesInWindow: 3,
        ...environment
      })
    )

    expect(readGpuFallbackMarker(userDataPath)?.source).toBe('automatic')
  })

  it('returns null when no marker exists', () => {
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
    expect(readActiveGpuFallbackMarker(userDataPath, environment)).toBeNull()
  })

  it('keeps an active marker for repeated launches on the same build', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 4 }, environment)
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(true)

    const firstRead = readActiveGpuFallbackMarker(userDataPath, environment)
    expect(firstRead?.crashesInWindow).toBe(4)
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(true)

    const secondRead = readActiveGpuFallbackMarker(userDataPath, environment)
    expect(secondRead?.crashesInWindow).toBe(4)
  })

  // Why: the update gets one fresh hardware attempt, but keeping the record is what stops a
  // machine that cannot boot from paying the full three-launch threshold again every release.
  it('retires an automatic marker on a new build as a superseded-build record', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: NOW, crashesInWindow: 4 }, environment)
    const updated = { ...environment, appVersion: '1.2.4' }

    expect(readActiveGpuFallbackMarker(userDataPath, updated, NOW)).toBeNull()
    expect(
      readGpuFallbackMarkerState(userDataPath, updated, NOW).supersededBuild?.crashesInWindow
    ).toBe(4)
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(true)

    clearSupersededGpuFallbackMarker(userDataPath, updated, NOW)
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('retires an automatic marker on a new Electron build too', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: NOW, crashesInWindow: 4 }, environment)
    const updated = { ...environment, electronVersion: '43.0.0' }

    expect(readGpuFallbackMarkerState(userDataPath, updated, NOW)).toEqual({
      active: null,
      supersededBuild: expect.objectContaining({ electronVersion: '42.3.3' })
    })
  })

  // Why: the superseded record lowers the threshold to a single crashing launch and has no
  // horizon of its own; its only reaper needs a launch that survives a minute, which a machine
  // used in short bursts never provides. Left forever, one spurious TDR a year later pins
  // software rendering for the whole build with no prompt.
  it('expires an automatic superseded-build record instead of keeping it as live evidence', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: NOW, crashesInWindow: 4 }, environment)
    const updated = { ...environment, appVersion: '1.2.4' }
    const aged = NOW + GPU_FALLBACK_SUPERSEDED_MARKER_MAX_AGE_MS + 1

    expect(readGpuFallbackMarkerState(userDataPath, updated, aged)).toEqual({
      active: null,
      supersededBuild: null
    })
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('keeps a superseded-build record inside its age, so an update still gets the head start', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: NOW, crashesInWindow: 4 }, environment)
    const updated = { ...environment, appVersion: '1.2.4' }
    const fresh = NOW + GPU_FALLBACK_SUPERSEDED_MARKER_MAX_AGE_MS

    expect(readGpuFallbackMarkerState(userDataPath, updated, fresh).supersededBuild).not.toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(true)
  })

  // Why: a pin is a standing choice with no expiry — only the user revokes it.
  it('never expires a user-pinned marker, however old', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: NOW, crashesInWindow: 0, source: 'user' },
      environment
    )
    const updated = { ...environment, appVersion: '1.2.4', electronVersion: '43.0.0' }
    const aged = NOW + GPU_FALLBACK_SUPERSEDED_MARKER_MAX_AGE_MS * 12

    expect(readActiveGpuFallbackMarker(userDataPath, updated, aged)?.source).toBe('user')
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(true)
  })

  // Why: the user asked for software rendering; shipping an update is not consent to undo it.
  it('keeps a user-pinned marker active across app and Electron updates', () => {
    writeGpuFallbackMarker(
      userDataPath,
      { engagedAt: 1, crashesInWindow: 0, source: 'user' },
      environment
    )
    const updated = { ...environment, appVersion: '1.2.4', electronVersion: '43.0.0' }

    expect(readActiveGpuFallbackMarker(userDataPath, updated)?.source).toBe('user')
    clearSupersededGpuFallbackMarker(userDataPath, updated)
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(true)
  })

  it('clears an active marker outside Windows', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 4 }, environment)

    expect(
      readActiveGpuFallbackMarker(userDataPath, {
        ...environment,
        platform: 'linux'
      })
    ).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  // Why: enableMainProcessGpuFeatures() is skipped while GPU fallback is active, and that function
  // carries the macOS disable-skia-graphite fix. A marker that survived on darwin would silently
  // strip the fix from the Macs it targets, so pin the platform gate for darwin specifically.
  it('clears an active marker on macOS so the Graphite fix is never skipped', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 4 }, environment)

    expect(
      readActiveGpuFallbackMarker(userDataPath, {
        ...environment,
        platform: 'darwin'
      })
    ).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('clears a corrupt or wrong-version marker', () => {
    writeFileSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE), '{ not json')
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
    expect(readActiveGpuFallbackMarker(userDataPath, environment)).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)

    writeFileSync(
      join(userDataPath, GPU_FALLBACK_MARKER_FILE),
      JSON.stringify({ schemeVersion: 999, engagedAt: 1, crashesInWindow: 1 })
    )
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
    expect(readActiveGpuFallbackMarker(userDataPath, environment)).toBeNull()
    expect(existsSync(join(userDataPath, GPU_FALLBACK_MARKER_FILE))).toBe(false)
  })

  it('can explicitly clear the marker', () => {
    writeGpuFallbackMarker(userDataPath, { engagedAt: 1, crashesInWindow: 4 }, environment)
    clearGpuFallbackMarker(userDataPath)
    expect(readGpuFallbackMarker(userDataPath)).toBeNull()
  })
})
