import { describe, expect, it } from 'vitest'
import { resolvePowerShellCommandMarkerTrust } from './shell-integration-injection-policy'

describe('resolvePowerShellCommandMarkerTrust', () => {
  it('allows POSIX PowerShell without interpreting the OS release', () => {
    expect(resolvePowerShellCommandMarkerTrust('darwin', 'not-a-windows-release')).toBe(true)
    expect(resolvePowerShellCommandMarkerTrust('linux', '')).toBe(true)
  })

  it('allows Windows 11 builds and rejects older or malformed releases', () => {
    expect(resolvePowerShellCommandMarkerTrust('win32', '10.0.22000')).toBe(true)
    expect(resolvePowerShellCommandMarkerTrust('win32', '10.0.26100')).toBe(true)
    expect(resolvePowerShellCommandMarkerTrust('win32', '10.0.21999')).toBe(false)
    expect(resolvePowerShellCommandMarkerTrust('win32', '10.0.not-a-build')).toBe(false)
    expect(resolvePowerShellCommandMarkerTrust('win32', '10.0')).toBe(false)
  })
})
