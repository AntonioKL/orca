import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restorePlatform, setPlatform } from './claude-account-service-test-harness'
import type * as NodeFsModule from 'node:fs'

// Fault injection at the filesystem, so the classifier under test is the thing
// deciding what an errno means. Keyed by path suffix: the probe reads several
// paths and only one of them is meant to be locked.
const fsFaults = vi.hoisted(() => ({
  lockedReadSuffix: null as string | null,
  lockedLstatSuffix: null as string | null
}))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFsModule>()
  const locked = (path: unknown, suffix: string | null) =>
    suffix !== null && String(path).endsWith(suffix)
  const busy = (path: unknown, syscall: string) => {
    const error = new Error(
      `EBUSY: resource busy or locked, ${syscall} '${String(path)}'`
    ) as NodeJS.ErrnoException
    error.code = 'EBUSY'
    error.syscall = syscall
    return error
  }
  const readFileSync = ((path: never, options: never) => {
    if (locked(path, fsFaults.lockedReadSuffix)) {
      throw busy(path, 'read')
    }
    return original.readFileSync(path, options)
  }) as typeof original.readFileSync
  const lstatSync = ((path: never, options: never) => {
    if (locked(path, fsFaults.lockedLstatSuffix)) {
      throw busy(path, 'lstat')
    }
    return original.lstatSync(path, options)
  }) as typeof original.lstatSync
  const mocked = { ...original, readFileSync, lstatSync }
  return { ...mocked, default: mocked }
})

const paths = vi.hoisted(() => ({ userDataRoot: '' }))

vi.mock('electron', () => ({ app: { getPath: () => paths.userDataRoot } }))

vi.mock('./keychain', () => ({
  deleteManagedClaudeKeychainCredentials: vi.fn(async () => {}),
  readManagedClaudeKeychainCredentials: vi.fn(),
  writeManagedClaudeKeychainCredentials: vi.fn(async () => {})
}))

const { MANAGED_AUTH_MARKER, resolveClaudeManagedAuthVerdict } = await import('./managed-auth-path')
const { ClaudeManagedAuthStorage } = await import('./claude-managed-auth-storage')
const { MISSING_MANAGED_AUTH_MESSAGE, OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE } =
  await import('./claude-managed-auth-ownership')

const ACCOUNT_ID = 'acct-5674'

function seedAccount(markerContents: string | null): string {
  const authPath = join(paths.userDataRoot, 'claude-accounts', ACCOUNT_ID, 'auth')
  mkdirSync(authPath, { recursive: true })
  if (markerContents !== null) {
    writeFileSync(join(authPath, MANAGED_AUTH_MARKER), markerContents)
  }
  return authPath
}

describe('host Claude managed-auth verdict', () => {
  beforeEach(() => {
    fsFaults.lockedReadSuffix = null
    fsFaults.lockedLstatSuffix = null
    paths.userDataRoot = mkdtempSync(join(tmpdir(), 'sta5674-verdict-'))
  })

  afterEach(() => {
    restorePlatform()
    fsFaults.lockedReadSuffix = null
    fsFaults.lockedLstatSuffix = null
    rmSync(paths.userDataRoot, { recursive: true, force: true })
  })

  it('accepts a directory whose marker names the account', () => {
    const authPath = seedAccount(`${ACCOUNT_ID}\n`)
    expect(resolveClaudeManagedAuthVerdict(ACCOUNT_ID, authPath)).toMatchObject({ kind: 'owned' })
  })

  it('refuses a symlinked candidate rather than following it', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'sta5674-elsewhere-'))
    writeFileSync(join(elsewhere, MANAGED_AUTH_MARKER), `${ACCOUNT_ID}\n`)
    const accountRoot = join(paths.userDataRoot, 'claude-accounts', ACCOUNT_ID)
    mkdirSync(accountRoot, { recursive: true })
    const authPath = join(accountRoot, 'auth')
    symlinkSync(elsewhere, authPath, 'dir')
    try {
      expect(resolveClaudeManagedAuthVerdict(ACCOUNT_ID, authPath).kind).toBe('untrusted')
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it("refuses a symlink even when it resolves to this account's own auth directory", () => {
    // The canonical-path checks alone would accept this: the link resolves to a
    // valid `<root>/<accountId>/auth`. Only the lstat guard rejects a persisted
    // path that is a link rather than the directory itself.
    seedAccount(`${ACCOUNT_ID}\n`)
    const linkPath = join(paths.userDataRoot, 'claude-accounts', ACCOUNT_ID, 'auth-link')
    symlinkSync('auth', linkPath, 'dir')
    expect(resolveClaudeManagedAuthVerdict(ACCOUNT_ID, linkPath).kind).toBe('untrusted')
  })

  it('reports an unreadable marker as indeterminate, not as a stranger directory', () => {
    const authPath = seedAccount(`${ACCOUNT_ID}\n`)
    fsFaults.lockedReadSuffix = MANAGED_AUTH_MARKER
    expect(resolveClaudeManagedAuthVerdict(ACCOUNT_ID, authPath).kind).toBe('indeterminate')
  })

  it('reports an unstattable marker as indeterminate', () => {
    const authPath = seedAccount(`${ACCOUNT_ID}\n`)
    fsFaults.lockedLstatSuffix = MANAGED_AUTH_MARKER
    expect(resolveClaudeManagedAuthVerdict(ACCOUNT_ID, authPath).kind).toBe('indeterminate')
  })

  it('treats a marker naming another account as a trust failure even when adoption is allowed', () => {
    // Adoption writes with `wx`, so the existing marker makes it EEXIST: proof
    // that a marker is there and is not ours, not a write we failed to make.
    const authPath = seedAccount('someone-elses-account\n')
    expect(
      resolveClaudeManagedAuthVerdict(ACCOUNT_ID, authPath, { adoptLegacyMarker: true }).kind
    ).toBe('untrusted')
  })

  it('adopts a legacy directory that has no marker at all', () => {
    const authPath = seedAccount(null)
    expect(
      resolveClaudeManagedAuthVerdict(ACCOUNT_ID, authPath, { adoptLegacyMarker: true })
    ).toMatchObject({ kind: 'owned' })
  })

  it('reports a missing directory as a definitive absence', () => {
    const authPath = join(paths.userDataRoot, 'claude-accounts', ACCOUNT_ID, 'auth')
    mkdirSync(join(paths.userDataRoot, 'claude-accounts'), { recursive: true })
    expect(resolveClaudeManagedAuthVerdict(ACCOUNT_ID, authPath)).toEqual({
      kind: 'untrusted',
      reason: MISSING_MANAGED_AUTH_MESSAGE
    })
  })
})

describe('WSL Claude managed-auth verdict', () => {
  beforeEach(() => {
    paths.userDataRoot = mkdtempSync(join(tmpdir(), 'sta5674-verdict-wsl-'))
  })

  afterEach(() => {
    restorePlatform()
    rmSync(paths.userDataRoot, { recursive: true, force: true })
  })

  it('refuses a guest path outside the managed accounts root without running a probe', async () => {
    setPlatform('win32')
    const storage = new ClaudeManagedAuthStorage()
    // Would throw if it reached `runWslProcess`, which is not mocked here.
    expect(await storage.resolveVerdict('\\\\wsl$\\Ubuntu\\home\\dev\\.ssh')).toEqual({
      kind: 'untrusted',
      reason: OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE
    })
    expect(
      await storage.resolveVerdict(
        '\\\\wsl$\\Ubuntu\\home\\dev\\.local\\share\\orca\\claude-accounts\\acct\\elsewhere'
      )
    ).toEqual({ kind: 'untrusted', reason: OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE })
  })
})
