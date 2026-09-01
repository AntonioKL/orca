import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { powerShellCommand } from './ssh-remote-powershell'

function decodePayload(command: string): string {
  const encoded = command.match(/ -EncodedCommand (\S+)$/)?.[1]
  if (!encoded) {
    throw new Error(`no -EncodedCommand payload in: ${command}`)
  }
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

/**
 * This one helper builds the command line for every remote-Windows SSH call site
 * (relay deploy, install locks, upload staging, GC claim, browse, CLI launch), so
 * its switches are worth pinning.
 */
describe('powerShellCommand', () => {
  it('spells no -ExecutionPolicy switch', () => {
    const command = powerShellCommand('exit 0')
    const switches = command.replace(/ -EncodedCommand \S+$/, '')

    // Why: `-EncodedCommand` is not execution-policy gated — only `-File` is — so the switch
    // was a no-op, and `-ExecutionPolicy Bypass` beside base64 is among the most heavily
    // EDR-flagged PowerShell command lines there is.
    expect(switches).not.toMatch(/-ExecutionPolicy/i)
    expect(switches).not.toMatch(/Bypass/i)
    expect(switches).toBe('powershell.exe -NoProfile -NonInteractive')
  })

  it('keeps the base64 payload the remote shell cannot rewrite', () => {
    // Why: this string is re-parsed by the remote host's sshd DefaultShell, which is
    // cmd.exe on a stock Windows OpenSSH install. Base64 is load-bearing here.
    const command = powerShellCommand("Write-Output 'a & b' | Out-String")

    expect(command).toMatch(
      /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/
    )
    expect(decodePayload(command)).toBe("Write-Output 'a & b' | Out-String")
  })
})

const MAIN_DIR = join(import.meta.dirname, '..')

function typeScriptSourcesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      typeScriptSourcesUnder(path, out)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(path)
    }
  }
  return out
}

/** Whole-line `//` and block comments only, so string contents are never eaten. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

// Why: execution policy gates loading script FILES and nothing else, so dropping
// `-ExecutionPolicy Bypass` is a no-op exactly while no remote payload loads one. That
// invariant is what makes the switch safe to omit, and it was previously guarded by nothing:
// a future payload that dot-sourced or used `-File` would fail only on a remote host whose
// LocalMachine policy is Restricted/AllSigned. See the invariant note on `powerShellCommand`.
const POLICY_GATED_CONSTRUCTS = [
  ['a PowerShell script file (.ps1/.psm1)', /\.psm?1\b/],
  ['Import-Module', /\bImport-Module\b/],
  ['the -File switch', /-File\b/],
  // The quote/backtick prefixes matter: a dot-source in a generated payload usually sits at the
  // very start of a TS string literal — `powerShellCommand(". '$x'")` — not after a `;`.
  ['dot-sourcing', /(^|[;{'"`]|\n)[ \t]*\.[ \t]+['"$]/]
] as const

describe('remote PowerShell payload invariant', () => {
  const importers = typeScriptSourcesUnder(MAIN_DIR).filter((path) =>
    readFileSync(path, 'utf8').includes('ssh-remote-powershell')
  )

  it('finds the modules that build remote payloads', () => {
    // Guards the scan itself: a resolution change that emptied this list would make every
    // assertion below vacuously pass.
    expect(importers.length).toBeGreaterThan(5)
  })

  it.each(POLICY_GATED_CONSTRUCTS)('loads no remote payload through %s', (label, pattern) => {
    const offenders = importers
      .filter((path) => pattern.test(withoutComments(readFileSync(path, 'utf8'))))
      .map((path) => relative(MAIN_DIR, path))

    expect(
      offenders,
      `${offenders.join(', ')} uses ${label}, which IS execution-policy gated on the remote ` +
        'host. Do not restore `-ExecutionPolicy Bypass` to the command line (a GPO scope ' +
        'beats it). Set the policy in-payload at process scope instead — see the note on ' +
        'powerShellCommand.'
    ).toEqual([])
  })

  it('detects the constructs it is meant to catch', () => {
    // Why: these patterns only earn trust if they fire on a real violation, spelled the way a
    // generated payload actually spells it — as the contents of a TS string literal. An earlier
    // dot-source pattern passed a `;`-prefixed sample but missed `powerShellCommand(". '$x'")`,
    // which is the far likelier shape, so each sample below keeps its surrounding quotes.
    const violations = [
      `powerShellCommand("$script = 'C:\\tools\\deploy.ps1'")`,
      `powerShellCommand("Import-Module 'NetSecurity'")`,
      `runRemote("powershell.exe -NoProfile -File 'C:\\tools\\deploy.ps1'")`,
      `powerShellCommand(". '$profileScript'")`
    ]
    for (const [index, [, pattern]] of POLICY_GATED_CONSTRUCTS.entries()) {
      expect(pattern.test(violations[index]!), violations[index]).toBe(true)
    }
  })
})
