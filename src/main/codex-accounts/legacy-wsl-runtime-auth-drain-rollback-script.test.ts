import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { _internals } from './legacy-wsl-runtime-auth-drain'

const SOURCE_AUTH = '{"tokens":{"expires_at":2000}}\n'
const TARGET_AUTH = '{"tokens":{"expires_at":1000}}\n'
const SOURCE_CREDENTIALS = '{"server":{"access_token":"source"}}\n'
const RETIRED_SESSION = '{"session":"retired"}\n'
const SESSION_SEGMENTS = ['sessions', '2026', '08', '26', 'retired.jsonl']

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

function runInspect(root: string, legacyHome: string, markerPath: string): number {
  try {
    execFileSync(
      '/bin/sh',
      [
        '-c',
        _internals.inspectLegacyAuthScript,
        'sh',
        legacyHome,
        join(root, 'absent-active-home'),
        markerPath
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }
    )
    return 0
  } catch (error) {
    return (error as { status?: number }).status ?? -1
  }
}

describe.skipIf(process.platform === 'win32')('legacy WSL auth drain rollback recovery', () => {
  it('reopens a completed drain when rollback recreated the retired home', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-drain-reland-'))
    const legacyHome = join(root, 'legacy')
    const targetHome = join(root, 'account')
    const markerPath = join(root, 'drain-marker.json')
    const legacyAuthPath = join(legacyHome, 'auth.json')
    const targetAuthPath = join(targetHome, 'auth.json')
    const targetCredentialsPath = join(targetHome, '.credentials.json')
    const sourceSessionPath = join(legacyHome, ...SESSION_SEGMENTS)
    const targetSessionPath = join(targetHome, ...SESSION_SEGMENTS)
    mkdirSync(join(sourceSessionPath, '..'), { recursive: true })
    mkdirSync(targetHome)
    writeFileSync(markerPath, '{"completed":true}\n')
    writeFileSync(legacyAuthPath, SOURCE_AUTH)
    writeFileSync(join(legacyHome, '.credentials.json'), SOURCE_CREDENTIALS)
    writeFileSync(sourceSessionPath, RETIRED_SESSION)
    writeFileSync(targetAuthPath, TARGET_AUTH)

    expect(runInspect(root, legacyHome, markerPath)).toBe(0)
    execFileSync(
      '/bin/sh',
      [
        '-c',
        _internals.applyLegacyAuthScript,
        'sh',
        legacyHome,
        join(root, 'absent-active-home'),
        markerPath,
        targetHome,
        sha256(SOURCE_AUTH),
        sha256(TARGET_AUTH),
        '1',
        '1',
        sha256(SOURCE_CREDENTIALS)
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }
    )

    expect(existsSync(legacyAuthPath)).toBe(false)
    expect(readFileSync(targetAuthPath, 'utf8')).toBe(SOURCE_AUTH)
    expect(readFileSync(targetCredentialsPath, 'utf8')).toBe(SOURCE_CREDENTIALS)
    expect(readFileSync(targetSessionPath, 'utf8')).toBe(RETIRED_SESSION)
    expect(existsSync(markerPath)).toBe(true)
  })

  it('keeps completion authoritative when rollback recreated auth as a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-drain-reland-symlink-'))
    const legacyHome = join(root, 'legacy')
    const markerPath = join(root, 'drain-marker.json')
    const linkedAuthPath = join(root, 'linked-auth.json')
    mkdirSync(legacyHome)
    writeFileSync(markerPath, '{"completed":true}\n')
    writeFileSync(linkedAuthPath, SOURCE_AUTH)
    symlinkSync(linkedAuthPath, join(legacyHome, 'auth.json'))

    expect(runInspect(root, legacyHome, markerPath)).toBe(46)
    expect(existsSync(markerPath)).toBe(true)
    expect(readFileSync(linkedAuthPath, 'utf8')).toBe(SOURCE_AUTH)
  })
})
