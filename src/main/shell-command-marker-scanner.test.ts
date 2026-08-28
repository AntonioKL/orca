import { describe, expect, it } from 'vitest'
import { ShellCommandMarkerScanner } from './shell-command-marker-scanner'

const marker = (nonce: string, command: string): string =>
  `\x1b]777;orca-cmd;${nonce};${Buffer.from(command).toString('base64')}\x07`

describe('ShellCommandMarkerScanner', () => {
  it('strips a split trusted marker and preserves surrounding Unicode in order', () => {
    const scanner = new ShellCommandMarkerScanner('nonce')
    const row = marker('nonce', 'codex --model test')
    expect(scanner.accept(`🙂A${row.slice(0, 12)}`)).toEqual([{ kind: 'data', data: '🙂A' }])
    expect(scanner.accept(`${row.slice(12)}B`)).toEqual([
      {
        kind: 'command-started',
        rawLength: row.length,
        event: { agent: 'codex', trusted: true }
      },
      { kind: 'data', data: 'B' }
    ])
  })

  it('strips a nonce mismatch but marks the fact untrusted', () => {
    const row = marker('wrong', 'claude')
    expect(new ShellCommandMarkerScanner('expected').accept(row)).toEqual([
      {
        kind: 'command-started',
        rawLength: row.length,
        event: { agent: 'claude', trusted: false }
      }
    ])
  })

  it('strips an empty nonce marker when the authority cannot mint one', () => {
    const row = marker('', 'claude')
    expect(new ShellCommandMarkerScanner(null).accept(row)).toEqual([
      {
        kind: 'command-started',
        rawLength: row.length,
        event: { agent: 'claude', trusted: false }
      }
    ])
  })

  it('preserves malformed private candidates byte-for-byte', () => {
    const malformed = '\x1b]777;orca-cmd;nonce;not_base64!\x07'
    expect(new ShellCommandMarkerScanner('nonce').accept(malformed)).toEqual([
      { kind: 'data', data: malformed }
    ])
  })

  it('emits null for a valid non-agent command', () => {
    const row = marker('nonce', 'git status')
    expect(new ShellCommandMarkerScanner('nonce').accept(row)).toEqual([
      {
        kind: 'command-started',
        rawLength: row.length,
        event: { agent: null, trusted: true }
      }
    ])
  })
})
