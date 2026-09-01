import { describe, expect, it } from 'vitest'
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
