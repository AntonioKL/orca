import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessSyncMock } = vi.hoisted(() => ({ runProcessSyncMock: vi.fn() }))
vi.mock('./child-process/run-process', () => ({ runProcessSync: runProcessSyncMock }))

import { getShipItLivenessForBundle } from './shipit-liveness'

const BUNDLE = '/Applications/Orca.app'
const SHIPIT = `${BUNDLE}/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt`
const SHIPIT_FRAMEWORK_ROOT = `${BUNDLE}/Contents/Frameworks/Squirrel.framework/Resources/ShipIt`

const psOutput = (...lines: string[]): void => {
  runProcessSyncMock.mockReturnValue({
    code: 0,
    stdout: lines.join('\n'),
    stderr: '',
    outputTruncated: false
  })
}

// Why: these assert darwin-only behaviour, and CI runs Linux.
const originalPlatform = process.platform
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

describe('isShipItRunningForBundle', () => {
  it('detects the installer for this bundle', () => {
    psOutput('/sbin/launchd', `${SHIPIT} com.stablyai.orca.ShipIt /tmp/state.plist`)
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('live')
  })

  it('matches an installer invoked with no arguments', () => {
    psOutput(SHIPIT)
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('live')
  })

  it('matches the framework-root resource path used by production ShipIt launches', () => {
    psOutput(`${SHIPIT_FRAMEWORK_ROOT} com.stablyai.orca.ShipIt /tmp/state.plist`)
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('live')
  })

  it('ignores a process that merely mentions the path', () => {
    // A substring match would count a grep, an editor, or this probe's own shell.
    psOutput(`/usr/bin/grep -r ${SHIPIT} /Users/someone/notes`)
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('exited')
  })

  it('does not treat a similarly named binary as this installer', () => {
    psOutput(`${SHIPIT}-other --run`)
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('exited')
  })

  it('ignores an installer belonging to a different bundle', () => {
    psOutput(
      '/Applications/Other.app/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt'
    )
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('exited')
  })

  it('reports unverifiable when ps fails — failing to look is not proof of absence', () => {
    runProcessSyncMock.mockReturnValue({
      code: 1,
      stdout: '',
      stderr: 'denied',
      outputTruncated: false
    })
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('unverifiable')
  })

  it('reports unverifiable when ps throws rather than claiming the installer exited', () => {
    runProcessSyncMock.mockImplementation(() => {
      throw new Error('spawn failed')
    })
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('unverifiable')
  })

  it('reports unverifiable when the process table was truncated', () => {
    runProcessSyncMock.mockReturnValue({ code: 0, stdout: '', stderr: '', outputTruncated: true })
    expect(getShipItLivenessForBundle(BUNDLE)).toBe('unverifiable')
  })

  it('bounds the probe so a wedged ps cannot stall startup', () => {
    psOutput('')
    getShipItLivenessForBundle(BUNDLE)
    expect(runProcessSyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: '/bin/ps', timeoutMs: 2_000 })
    )
  })
})
