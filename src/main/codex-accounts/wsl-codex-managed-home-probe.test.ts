import { describe, expect, it, vi } from 'vitest'

vi.mock('../wsl', () => ({
  toWindowsWslPath: (linuxPath: string, distro: string) =>
    `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}))

import {
  ACCOUNT_ID_MISMATCH_MESSAGE,
  buildWslCodexManagedHomeProbeScript,
  classifyWslCodexManagedHomeProbe,
  MARKER_ACCOUNT_MISMATCH_MESSAGE,
  OUTSIDE_MANAGED_ROOT_MESSAGE
} from './wsl-codex-managed-home-probe'
import {
  MISSING_MANAGED_HOME_MESSAGE,
  MISSING_OWNERSHIP_MARKER_MESSAGE
} from './host-codex-managed-home-ownership'

const DISTRO = 'Ubuntu'
const LINUX_HOME = '/home/dev/.local/share/orca/codex-accounts/account-1/home'

function tagged(value: string): string {
  return `ORCA_CODEX_HOME_VERDICT:${value}\n`
}

function owned(linuxPath = LINUX_HOME): string {
  return tagged(`owned:${Buffer.from(linuxPath, 'utf-8').toString('base64')}`)
}

describe('buildWslCodexManagedHomeProbeScript', () => {
  it('single-quotes the candidate path so a crafted path cannot inject shell', () => {
    const script = buildWslCodexManagedHomeProbeScript("/home/dev/'; rm -rf /; '", 'account-1')

    expect(script).toContain(`candidate='/home/dev/'\\''; rm -rf /; '\\'''`)
    expect(script).not.toMatch(/^\s*rm -rf/m)
  })

  it('pins the home to the expected account when one is given', () => {
    const script = buildWslCodexManagedHomeProbeScript(LINUX_HOME, 'account-1')

    expect(script).toContain(`expected_marker='account-1'`)
    expect(script).toContain('test "$candidate_real" = "$managed_root_real/$expected_marker/home"')
    expect(script).toContain('test "$contents" = "$expected_marker"')
  })

  it('accepts any managed account home when no account is given', () => {
    const script = buildWslCodexManagedHomeProbeScript(LINUX_HOME)

    expect(script).not.toContain('expected_marker')
    expect(script).toContain('test -n "$contents" || tag marker-mismatch')
  })

  it('never lets the guest end on a bare non-zero exit for an ownership fact', () => {
    const script = buildWslCodexManagedHomeProbeScript(LINUX_HOME, 'account-1')

    // Every structural fact is reported through `tag`, which exits 0; the bare
    // `exit 1`s are reserved for reads that failed and prove nothing.
    expect(script).not.toContain('exit 35')
    expect(script.match(/\|\| exit 1$/gm)?.length).toBeGreaterThan(0)
  })
})

describe('classifyWslCodexManagedHomeProbe', () => {
  it('treats a runner failure as indeterminate', () => {
    const cause = new Error('spawnSync wsl.exe ETIMEDOUT')

    const verdict = classifyWslCodexManagedHomeProbe({ ran: false, error: cause }, DISTRO)

    expect(verdict.kind).toBe('indeterminate')
    expect((verdict as { error: Error }).error.cause).toBe(cause)
  })

  it.each([
    ['', 'no output at all'],
    ['/home/dev/some/path\n', 'a bare path, as the pre-STA-5616 protocol emitted'],
    [`${owned()}trailing chatter\n`, 'output after the verdict'],
    [`${owned()}${owned()}`, 'two verdicts'],
    [tagged('who-knows'), 'an unrecognised tag'],
    [tagged('owned:!!!not-base64!!!'), 'an undecodable path']
  ])('treats %j as indeterminate (%s)', (stdout) => {
    expect(classifyWslCodexManagedHomeProbe({ ran: true, stdout }, DISTRO).kind).toBe(
      'indeterminate'
    )
  })

  it.each([
    ['missing-home', MISSING_MANAGED_HOME_MESSAGE],
    ['missing-marker', MISSING_OWNERSHIP_MARKER_MESSAGE],
    ['marker-mismatch', MARKER_ACCOUNT_MISMATCH_MESSAGE],
    ['account-mismatch', ACCOUNT_ID_MISMATCH_MESSAGE],
    ['outside-managed-root', OUTSIDE_MANAGED_ROOT_MESSAGE]
  ])('treats the %s tag as a dispositive untrusted verdict', (tag, reason) => {
    expect(classifyWslCodexManagedHomeProbe({ ran: true, stdout: tagged(tag) }, DISTRO)).toEqual({
      kind: 'untrusted',
      reason
    })
  })

  it('decodes an owned verdict back to its Windows spelling', () => {
    expect(classifyWslCodexManagedHomeProbe({ ran: true, stdout: owned() }, DISTRO)).toEqual({
      kind: 'owned',
      homePath: `\\\\wsl.localhost\\Ubuntu${LINUX_HOME.replace(/\//g, '\\')}`
    })
  })

  it('tolerates CRLF and NUL padding from the wsl.exe pipe', () => {
    const stdout = `${String.fromCharCode(0)} ${owned().trimEnd()}\r\n`

    expect(classifyWslCodexManagedHomeProbe({ ran: true, stdout }, DISTRO).kind).toBe('owned')
  })

  it('carries a home whose name embeds the tag without truncating it', () => {
    const oddPath = '/home/dev/.local/share/orca/codex-accounts/ORCA_CODEX_HOME_VERDICT:x/home'

    const verdict = classifyWslCodexManagedHomeProbe({ ran: true, stdout: owned(oddPath) }, DISTRO)

    expect(verdict).toEqual({
      kind: 'owned',
      homePath: `\\\\wsl.localhost\\Ubuntu${oddPath.replace(/\//g, '\\')}`
    })
  })
})
