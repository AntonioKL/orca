import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from './child-process/run-process'
import { windowsSystem32Binary } from './child-process/windows-system-binary'
import {
  resetSecureFileWindowsUserSidForTests,
  restrictWindowsPathSync
} from './secure-path-windows-acl'

/**
 * The half of the proof a mocked argv test cannot give.
 *
 * The shipped bug was not a wrong argv — it was an argv the *callee* never
 * received: `powershell.exe -Command <script> <path> <sid>` leaves `$args`
 * empty, so the script died on its first statement and every caller was told
 * the path had been hardened. Asserting on the constructed arguments passed
 * happily throughout. Only reading the resulting ACL back off a real file
 * catches it, so that is what this does.
 *
 * Runs only on win32; skipped elsewhere.
 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

const EVERYONE_SID = 'S-1-1-0'

function icacls(...args: string[]): { code: number | null; stdout: string } {
  const result = runProcessSync({
    program: windowsSystem32Binary('icacls.exe'),
    args,
    timeoutMs: 10_000
  })
  return { code: result.code, stdout: result.stdout }
}

/**
 * The `Principal:(flags)` entries of `icacls <path>`. The first line carries the path, which is
 * stripped by the exact string passed in so its own spaces cannot be mistaken for the separator.
 */
function readAclEntries(path: string): string[] {
  const arg = path.length < 260 ? path : `\\\\?\\${path}`
  const { stdout } = icacls(arg)
  const entries: string[] = []
  for (const [index, rawLine] of stdout.split(/\r?\n/).entries()) {
    const line = index === 0 ? rawLine.slice(arg.length) : rawLine
    const trimmed = line.trim()
    if (!trimmed && index > 0) {
      break
    }
    if (trimmed.includes(':(')) {
      entries.push(trimmed)
    }
  }
  return entries
}

describeOnWindows('restrictWindowsPathSync against a real filesystem', () => {
  let root: string

  beforeAll(() => {
    resetSecureFileWindowsUserSidForTests()
    root = mkdtempSync(join(tmpdir(), 'orca-acl-win32-'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('actually applies the ACL to a real file, dropping inherited and foreign ACEs', () => {
    const file = join(root, 'credential.json')
    writeFileSync(file, '{"token":"secret"}')
    // A planted explicit ACE: /inheritance:r alone does not remove these.
    expect(icacls(file, '/grant', `*${EVERYONE_SID}:(R)`).code).toBe(0)

    const before = readAclEntries(file)
    expect(before.some((entry) => entry.startsWith('Everyone:'))).toBe(true)
    expect(before.some((entry) => entry.includes('(I)'))).toBe(true)

    expect(restrictWindowsPathSync(file, false)).toBe(true)

    const after = readAclEntries(file)
    // No inherited ACE survives: the DACL is protected.
    expect(after.every((entry) => !entry.includes('(I)'))).toBe(true)
    expect(after.some((entry) => entry.startsWith('Everyone:'))).toBe(false)
    // Exactly the three intended principals, each with FullControl.
    expect(after).toHaveLength(3)
    expect(after.every((entry) => entry.endsWith(':(F)'))).toBe(true)
  })

  it('gives a real directory inheritable rules so files created inside stay restricted', () => {
    const dir = join(root, 'secure-dir')
    mkdirSync(dir)

    expect(restrictWindowsPathSync(dir, true)).toBe(true)

    const after = readAclEntries(dir)
    expect(after).toHaveLength(3)
    expect(after.every((entry) => entry.endsWith(':(OI)(CI)(F)'))).toBe(true)
    expect(after.every((entry) => !entry.includes('(I)'))).toBe(true)

    // The point of the inheritance flags: a child written afterwards is already restricted.
    const child = join(dir, 'inherited.json')
    writeFileSync(child, '{}')
    const childEntries = readAclEntries(child)
    expect(childEntries).toHaveLength(3)
    expect(childEntries.every((entry) => entry.includes('(I)'))).toBe(true)
    expect(childEntries.some((entry) => entry.startsWith('Everyone:'))).toBe(false)
  })

  // Paths reach this code from user-chosen workspace locations, so the quoting hazards that
  // ruled out interpolating them into a PowerShell command line get exercised for real.
  it.each([
    ['spaces', 'a b c'],
    ['single quote and dollar', "quo'te $var"],
    ['backtick', 'back`tick'],
    ['brackets', 'brack[et]s'],
    ['semicolon and ampersand', 'semi;colon & amp'],
    ['comma', 'com,ma'],
    ['parentheses', 'paren(s)'],
    ['caret and percent', 'car^et %PATH%']
  ])('hardens a path containing %s', (_label, segment) => {
    const dir = join(root, segment)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'secret.json')
    writeFileSync(file, '{}')

    expect(restrictWindowsPathSync(file, false)).toBe(true)

    const after = readAclEntries(file)
    expect(after).toHaveLength(3)
    expect(after.every((entry) => !entry.includes('(I)'))).toBe(true)
  })

  it('hardens a path longer than MAX_PATH', () => {
    let dir = join(root, 'long')
    while (dir.length < 280) {
      dir = join(dir, 'x'.repeat(40))
    }
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'secret.json')
    expect(file.length).toBeGreaterThan(260)
    writeFileSync(file, '{}')

    expect(restrictWindowsPathSync(file, false)).toBe(true)
    expect(readAclEntries(file)).toHaveLength(3)
  })

  /**
   * The shape of a DACL is not the same question as who is on it. This one is protected, carries
   * exactly three non-inherited full-control rules, and grants Everyone — so it satisfies every
   * check that does not compare SIDs, and hardening would report success and leave it alone.
   */
  it('repairs a protected three-rule DACL that grants the wrong principal', () => {
    const file = join(root, 'substituted.json')
    writeFileSync(file, '{"token":"secret"}')
    expect(
      icacls(
        file,
        '/inheritance:r',
        '/grant:r',
        `*${EVERYONE_SID}:(F)`,
        '/grant:r',
        '*S-1-5-18:(F)',
        '/grant:r',
        '*S-1-5-32-544:(F)',
        '/q'
      ).code
    ).toBe(0)

    const before = readAclEntries(file)
    expect(before).toHaveLength(3)
    expect(before.every((entry) => !entry.includes('(I)'))).toBe(true)
    expect(before.some((entry) => entry.startsWith('Everyone:'))).toBe(true)

    expect(restrictWindowsPathSync(file, false)).toBe(true)

    const after = readAclEntries(file)
    expect(after).toHaveLength(3)
    expect(after.some((entry) => entry.startsWith('Everyone:'))).toBe(false)
  })

  it('is idempotent: a second harden leaves the same DACL', () => {
    const file = join(root, 'idempotent.json')
    writeFileSync(file, '{}')

    expect(restrictWindowsPathSync(file, false)).toBe(true)
    const first = readAclEntries(file)
    expect(restrictWindowsPathSync(file, false)).toBe(true)

    expect(readAclEntries(file)).toEqual(first)
  })

  /**
   * Verification writes a temp SDDL file. If it cannot, the ACL may well have been applied — but
   * it cannot be *proved*, so hardening must report failure rather than assume success. Fail
   * closed, and say so: a silently-unverifiable control is the shape of the original bug.
   */
  it('reports failure, loudly, when verification cannot write its descriptor', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const file = join(root, 'unverifiable.json')
    writeFileSync(file, '{}')
    const realTemp = process.env.TEMP
    const realTmp = process.env.TMP
    // Point the descriptor save at a directory that cannot exist.
    process.env.TEMP = join(root, 'no-such-dir', 'nested')
    process.env.TMP = process.env.TEMP

    try {
      expect(restrictWindowsPathSync(file, false)).toBe(false)
      expect(warn).toHaveBeenCalledWith(
        '[secure-path.windows-acl] failed to restrict path',
        expect.objectContaining({ stage: 'verify' })
      )
    } finally {
      if (realTemp === undefined) {
        delete process.env.TEMP
      } else {
        process.env.TEMP = realTemp
      }
      if (realTmp === undefined) {
        delete process.env.TMP
      } else {
        process.env.TMP = realTmp
      }
      warn.mockRestore()
    }

    // And the ACL itself was still applied, so the failure is a loss of proof, not of protection.
    expect(readAclEntries(file)).toHaveLength(3)
  })

  it('reports failure for a path that does not exist', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(restrictWindowsPathSync(join(root, 'absent.json'), false)).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      '[secure-path.windows-acl] failed to restrict path',
      expect.objectContaining({ stage: 'reset' })
    )
    warn.mockRestore()
  })

  it('reports failure for a path it has no permission to modify', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Owned by TrustedInstaller; a non-elevated user cannot rewrite its DACL.
    const systemFile = windowsSystem32Binary('drivers\\etc\\hosts')

    const restricted = restrictWindowsPathSync(systemFile, false)

    if (restricted) {
      // Elevated runner: nothing to assert about denial, but never leave the box altered.
      expect(icacls(systemFile, '/reset').code).toBe(0)
    } else {
      expect(warn).toHaveBeenCalledWith(
        '[secure-path.windows-acl] failed to restrict path',
        expect.objectContaining({ detail: expect.stringContaining('denied') })
      )
    }
    warn.mockRestore()
  })
})
