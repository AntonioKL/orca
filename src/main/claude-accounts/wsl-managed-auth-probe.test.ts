import { describe, expect, it, vi } from 'vitest'
import {
  isUnprovenManagedClaudeAuthError,
  ManagedClaudeAuthTemporarilyUnavailableError,
  MISSING_MANAGED_AUTH_MESSAGE,
  OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE,
  UntrustedManagedClaudeAuthError,
  UNTRUSTED_MANAGED_AUTH_MESSAGE
} from './claude-managed-auth-ownership'

vi.mock('../wsl', () => ({
  toWindowsWslPath: (linuxPath: string) => `\\\\wsl$\\Ubuntu${linuxPath}`
}))

import {
  buildWslManagedAuthProbeScript,
  classifyWslManagedAuthProbe
} from './wsl-managed-auth-probe'

const TAG = 'ORCA_CLAUDE_AUTH_VERDICT:'
const GUEST_PATH = '/home/dev/.local/share/orca/claude-accounts/acct-1/auth'

function probe(overrides: Partial<Parameters<typeof classifyWslManagedAuthProbe>[0]> = {}) {
  return classifyWslManagedAuthProbe(
    { environmentResolved: true, code: 0, stdout: '', stderr: '', timedOut: false, ...overrides },
    'Ubuntu'
  )
}

function ownedTag(path: string) {
  return `${TAG}owned:${Buffer.from(path, 'utf-8').toString('base64')}\n`
}

describe('WSL Claude managed-auth probe classification', () => {
  it('reports a completed guest observation as the verdict it names', () => {
    expect(probe({ stdout: ownedTag(GUEST_PATH) })).toEqual({
      kind: 'owned',
      authPath: `\\\\wsl$\\Ubuntu${GUEST_PATH}`
    })
    expect(probe({ stdout: `${TAG}missing-marker\n` })).toEqual({
      kind: 'untrusted',
      reason: MISSING_MANAGED_AUTH_MESSAGE
    })
    expect(probe({ stdout: `${TAG}marker-mismatch\n` })).toEqual({
      kind: 'untrusted',
      reason: UNTRUSTED_MANAGED_AUTH_MESSAGE
    })
    expect(probe({ stdout: `${TAG}outside-managed-root\n` })).toEqual({
      kind: 'untrusted',
      reason: OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE
    })
  })

  it('survives a guest path containing a colon and CRLF line endings', () => {
    const oddPath = '/home/de:v/.local/share/orca/claude-accounts/acct-1/auth'
    expect(probe({ stdout: `${ownedTag(oddPath).trimEnd()}\r\n` })).toEqual({
      kind: 'owned',
      authPath: `\\\\wsl$\\Ubuntu${oddPath}`
    })
  })

  // Each of these used to be reported as a trust or absence verdict, which is
  // what let a cold distro read as "this is not your auth directory".
  it.each([
    ['a timeout', { timedOut: true, code: null, stdout: '' }],
    ['a timeout that still reported exit 0', { timedOut: true, code: 0, stdout: '' }],
    ['an unresolved distro environment', { environmentResolved: false }],
    ['a non-zero exit', { code: 1, stdout: '' }],
    ['a non-zero exit that printed a verdict', { code: 1, stdout: `${TAG}missing-marker\n` }],
    ['no verdict at all', { stdout: 'bash: base64: command not found\n' }],
    ['empty output', { stdout: '' }],
    ['more than one verdict', { stdout: `${TAG}missing-marker\n${TAG}outside-managed-root\n` }],
    ['a verdict that is not the last line', { stdout: `${TAG}missing-marker\ntrailing\n` }],
    ['an unknown verdict', { stdout: `${TAG}sideways\n` }],
    ['an undecodable owned path', { stdout: `${TAG}owned:!!!not-base64!!!\n` }],
    ['an owned verdict with no path', { stdout: `${TAG}owned:\n` }]
  ])('reports %s as indeterminate', (_label, overrides) => {
    expect(probe(overrides).kind).toBe('indeterminate')
  })

  it('builds a guest script that quotes its inputs and never relies on set -e for meaning', () => {
    const script = buildWslManagedAuthProbeScript(GUEST_PATH, "acct'1")
    expect(script).toContain(`candidate='${GUEST_PATH}'`)
    expect(script).toContain(`test "$contents" = 'acct'\\''1'`)
    expect(script.split('\n')[0]).toBe('set -uo pipefail')
    // Without an expected account ID the marker only has to be non-empty.
    expect(buildWslManagedAuthProbeScript(GUEST_PATH)).toContain('test -n "$contents"')
  })
})

describe('Claude managed-auth error vocabulary', () => {
  it('recognises an unproven failure through a chain of causes', () => {
    const unavailable = new ManagedClaudeAuthTemporarilyUnavailableError()
    expect(isUnprovenManagedClaudeAuthError(unavailable)).toBe(true)
    expect(isUnprovenManagedClaudeAuthError(new Error('wrapped', { cause: unavailable }))).toBe(
      true
    )
    expect(
      isUnprovenManagedClaudeAuthError(
        new Error('outer', { cause: new Error('inner', { cause: unavailable }) })
      )
    ).toBe(true)
  })

  it('does not mistake a proven trust failure, or anything else, for an unproven one', () => {
    expect(isUnprovenManagedClaudeAuthError(new UntrustedManagedClaudeAuthError('nope'))).toBe(
      false
    )
    expect(isUnprovenManagedClaudeAuthError(new Error('login failed'))).toBe(false)
    expect(isUnprovenManagedClaudeAuthError(null)).toBe(false)
    expect(isUnprovenManagedClaudeAuthError('temporarily locked')).toBe(false)
  })

  it('terminates on a self-referential cause chain', () => {
    const looping = new Error('loop') as Error & { cause?: unknown }
    looping.cause = looping
    expect(isUnprovenManagedClaudeAuthError(looping)).toBe(false)
  })
})
