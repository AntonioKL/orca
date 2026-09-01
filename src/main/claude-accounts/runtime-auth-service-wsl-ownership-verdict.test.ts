import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as NodeFsModule from 'node:fs'
import type * as WslPathsModule from '../../shared/wsl-paths'
import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createElectronMock,
  createManagedClaudeAuth,
  createKeychainMock,
  createOauthRefreshMock,
  createSettings,
  createStore,
  resetRuntimeAuthTestState,
  setPlatform,
  testState
} from './runtime-auth-service-test-harness'

const fsFaults = vi.hoisted(() => ({ lockedRealpathSuffix: null as string | null }))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFsModule>()
  const realpathSync = ((path: never, options: never) => {
    if (
      fsFaults.lockedRealpathSuffix !== null &&
      String(path).endsWith(fsFaults.lockedRealpathSuffix)
    ) {
      const error = new Error(`EBUSY: resource busy or locked, realpath`) as NodeJS.ErrnoException
      error.code = 'EBUSY'
      throw error
    }
    return original.realpathSync(path, options)
  }) as typeof original.realpathSync
  realpathSync.native = original.realpathSync.native
  const mocked = { ...original, realpathSync }
  return { ...mocked, default: mocked }
})

vi.mock('electron', () => createElectronMock())
vi.mock('./oauth-refresh', () => createOauthRefreshMock())
vi.mock('./keychain', () => createKeychainMock())

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>() // eslint-disable-line @typescript-eslint/consistent-type-imports -- harness parity
  return { ...actual, homedir: () => testState.fakeHomeDir }
})

// The guest tree lives in the test's temp dir so the credential bytes the sync
// reads after a proven verdict are real bytes; these two shims are what make a
// guest path addressable by `node:fs` on a POSIX host.
vi.mock('../wsl', () => ({
  getDefaultWslDistro: () => 'Ubuntu',
  getWslHome: () => null,
  toWindowsWslPath: (linuxPath: string) => linuxPath
}))

vi.mock('../../shared/wsl-paths', async (importOriginal) => {
  const original = await importOriginal<typeof WslPathsModule>()
  return {
    ...original,
    parseWslUncPath: (path: string) =>
      path.includes('/.local/share/orca/claude-accounts/')
        ? { distro: 'Ubuntu', linuxPath: path }
        : original.parseWslUncPath(path)
  }
})

const wslMocks = vi.hoisted(() => ({ runWslProcess: vi.fn() }))

vi.mock('../wsl/wsl-runner', () => ({
  runWslProcess: wslMocks.runWslProcess,
  DEFAULT_WSL_TIMEOUT_MS: 30_000
}))

const TAG = 'ORCA_CLAUDE_AUTH_VERDICT:'

function guestAuthPath(): string {
  return join(testState.userDataDir, 'guest/.local/share/orca/claude-accounts/ubuntu-account/auth')
}

function seedGuestAuth(): string {
  const authPath = guestAuthPath()
  mkdirSync(authPath, { recursive: true })
  writeFileSync(join(authPath, '.orca-managed-claude-auth'), 'ubuntu-account\n')
  writeFileSync(
    join(authPath, '.credentials.json'),
    createClaudeCredentialsJson('alice@example.com', 'alice-token')
  )
  writeFileSync(join(authPath, 'oauth-account.json'), '{"accountUuid":"ubuntu-account"}\n')
  return authPath
}

function wslResult(overrides: Record<string, unknown> = {}) {
  return {
    environmentResolved: true,
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides
  }
}

function buildStore() {
  const settings = createSettings({
    localAccountRuntime: 'wsl',
    localAccountWslDistro: 'Ubuntu',
    claudeManagedAccounts: [
      createClaudeAccount('ubuntu-account', guestAuthPath(), {
        managedAuthRuntime: 'wsl',
        wslDistro: 'Ubuntu',
        wslLinuxAuthPath: guestAuthPath()
      })
    ],
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'ubuntu-account' } }
  })
  return createStore(settings)
}

async function syncWithProbe(probe: ReturnType<typeof wslResult> | Error) {
  const store = buildStore()
  wslMocks.runWslProcess.mockImplementation(async () => {
    if (probe instanceof Error) {
      throw probe
    }
    return probe
  })
  const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
  const service = new ClaudeRuntimeAuthService(store as never)
  await service.syncForCurrentSelection({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  return store
}

function selectedUbuntuAccount(store: ReturnType<typeof buildStore>): string | null {
  return store.getSettings().activeClaudeManagedAccountIdsByRuntime?.wsl?.Ubuntu ?? null
}

describe('runtime-auth WSL ownership probe', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
    wslMocks.runWslProcess.mockReset()
    fsFaults.lockedRealpathSuffix = null
    setPlatform('win32')
  })

  afterEach(() => {
    fsFaults.lockedRealpathSuffix = null
    cleanupRuntimeAuthTestState()
  })

  // Each of these is a probe that did not complete. Clearing the user's active
  // WSL account on one is the STA-5674 defect in the second lane: "we could not
  // check" reported as "this is not your account".
  it.each([
    ['a non-zero exit', wslResult({ code: 1 })],
    ['a timeout', wslResult({ timedOut: true, code: null })],
    ['an unresolved distro environment', wslResult({ environmentResolved: false })],
    ['output with no verdict', wslResult({ stdout: 'bash: base64: not found\n' })],
    ['a spawn failure', new Error('wsl.exe is not on PATH')]
  ])('keeps the active WSL account when the probe reports %s', async (_label, probe) => {
    const store = await syncWithProbe(probe)
    expect(selectedUbuntuAccount(store)).toBe('ubuntu-account')
  })

  it('still clears the active WSL account on a completed guest observation of untrust', async () => {
    const store = await syncWithProbe(wslResult({ stdout: `${TAG}marker-mismatch\n` }))
    expect(selectedUbuntuAccount(store)).toBeNull()
  })

  it('keeps the active WSL account when the guest proves ownership', async () => {
    const authPath = seedGuestAuth()
    const owned = `${TAG}owned:${Buffer.from(authPath, 'utf-8').toString('base64')}\n`
    const store = await syncWithProbe(wslResult({ stdout: owned }))
    expect(selectedUbuntuAccount(store)).toBe('ubuntu-account')
  })

  it('clears the active WSL account when a proven-owned directory has no credentials', async () => {
    const authPath = guestAuthPath()
    mkdirSync(authPath, { recursive: true })
    writeFileSync(join(authPath, '.orca-managed-claude-auth'), 'ubuntu-account\n')
    const owned = `${TAG}owned:${Buffer.from(authPath, 'utf-8').toString('base64')}\n`
    const store = await syncWithProbe(wslResult({ stdout: owned }))
    expect(selectedUbuntuAccount(store)).toBeNull()
  })

  it('does not re-probe after ownership is proven', async () => {
    // A second probe can fail where the first succeeded, and its null reaches
    // sync as "missing credentials" — which clears the selection just the same.
    const authPath = seedGuestAuth()
    const owned = `${TAG}owned:${Buffer.from(authPath, 'utf-8').toString('base64')}\n`
    const store = buildStore()
    let probes = 0
    wslMocks.runWslProcess.mockImplementation(async () => {
      probes += 1
      return probes === 1 ? wslResult({ stdout: owned }) : wslResult({ code: 1 })
    })
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    await service.syncForCurrentSelection({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    // Not a probe-count assertion: `syncForCurrentSelection` legitimately runs
    // more than one pass. What must hold is that no pass turns a proven verdict
    // into a cleared selection by asking the guest a second time.
    expect(probes).toBeGreaterThan(0)
    expect(selectedUbuntuAccount(store)).toBe('ubuntu-account')
  })
})

describe('runtime-auth host ownership probe', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
    fsFaults.lockedRealpathSuffix = null
    setPlatform('linux')
  })

  afterEach(() => {
    fsFaults.lockedRealpathSuffix = null
    cleanupRuntimeAuthTestState()
  })

  async function syncHost() {
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'host-account',
      createClaudeCredentialsJson('alice@example.com', 'alice-token')
    )
    const settings = createSettings({
      claudeManagedAccounts: [createClaudeAccount('host-account', managedAuthPath)],
      activeClaudeManagedAccountId: 'host-account',
      activeClaudeManagedAccountIdsByRuntime: { host: 'host-account', wsl: {} }
    })
    const store = createStore(settings)
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    await new ClaudeRuntimeAuthService(store as never).syncForCurrentSelection()
    return store
  }

  it('keeps the active host account when the ownership check cannot complete', async () => {
    fsFaults.lockedRealpathSuffix = join('host-account', 'auth')
    const store = await syncHost()
    expect(store.getSettings().activeClaudeManagedAccountId).toBe('host-account')
  })

  it('still clears the active host account when its directory is proven gone', async () => {
    const store = await (async () => {
      const managedAuthPath = createManagedClaudeAuth(
        testState.userDataDir,
        'host-account',
        createClaudeCredentialsJson('alice@example.com', 'alice-token')
      )
      rmSync(managedAuthPath, { recursive: true, force: true })
      const settings = createSettings({
        claudeManagedAccounts: [createClaudeAccount('host-account', managedAuthPath)],
        activeClaudeManagedAccountId: 'host-account',
        activeClaudeManagedAccountIdsByRuntime: { host: 'host-account', wsl: {} }
      })
      const store = createStore(settings)
      const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
      await new ClaudeRuntimeAuthService(store as never).syncForCurrentSelection()
      return store
    })()
    expect(store.getSettings().activeClaudeManagedAccountId).toBeNull()
  })
})
