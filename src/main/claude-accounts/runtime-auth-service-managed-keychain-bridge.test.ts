import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createClaudeCredentialsWithoutEmail,
  createElectronMock,
  createKeychainMock,
  createManagedClaudeAuth,
  createOauthRefreshMock,
  createSettings,
  createStore,
  expectedRuntimeConfigDir,
  resetRuntimeAuthTestState,
  setScopedKeychainCredentialsForManagedPath,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => createElectronMock())

vi.mock('./oauth-refresh', () => createOauthRefreshMock())

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

vi.mock('./keychain', () => createKeychainMock())

describe('ClaudeRuntimeAuthService', () => {
  beforeEach(() => {
    resetRuntimeAuthTestState()
  })

  afterEach(() => {
    cleanupRuntimeAuthTestState()
  })

  it('bridges host managed credentials into the macOS config-scoped Keychain item', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const credentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const managedAuthPath = createManagedClaudeAuth(testState.userDataDir, 'account-1', credentials)
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createClaudeAccount('account-1', managedAuthPath, { managedAuthRuntime: 'host' })
        ],
        activeClaudeManagedAccountId: 'account-1'
      })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    await service.prepareForClaudeLaunch()

    expect(testState.scopedKeychainCredentials).toBe(credentials)
    expect(testState.legacyKeychainCredentials).toBeNull()
  })

  it('repairs a stale scoped Keychain item after re-authentication', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const staleCredentials = createClaudeCredentialsJson('user@example.com', 'stale')
    const freshCredentials = createClaudeCredentialsJson('user@example.com', 'fresh')
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      staleCredentials
    )
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createClaudeAccount('account-1', managedAuthPath, { managedAuthRuntime: 'host' })
        ],
        activeClaudeManagedAccountId: 'account-1'
      })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    await service.prepareForClaudeLaunch()
    testState.managedKeychainCredentials.set('account-1', freshCredentials)
    testState.scopedKeychainCredentials = staleCredentials
    service.clearLastWrittenCredentialsJson('account-1')

    await service.prepareForClaudeLaunch()

    expect(testState.managedKeychainCredentials.get('account-1')).toBe(freshCredentials)
    expect(testState.scopedKeychainCredentials).toBe(freshCredentials)
  })

  it('does not import a different identity from the scoped Keychain item', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const managedCredentials = createClaudeCredentialsJson(
      'user@example.com',
      'managed',
      null,
      2_000
    )
    const foreignCredentials = createClaudeCredentialsJson(
      'other@example.com',
      'foreign',
      null,
      3_000
    )
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createClaudeAccount('account-1', managedAuthPath, { managedAuthRuntime: 'host' })
        ],
        activeClaudeManagedAccountId: 'account-1'
      })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    await service.prepareForClaudeLaunch()
    setScopedKeychainCredentialsForManagedPath(managedAuthPath, foreignCredentials)
    await service.prepareForClaudeLaunch()

    expect(testState.managedKeychainCredentials.get('account-1')).toBe(managedCredentials)
    expect(testState.scopedKeychainCredentials).toBe(managedCredentials)
  })

  it('does not import an older same-identity scoped Keychain credential', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const managedCredentials = createClaudeCredentialsJson(
      'user@example.com',
      'managed',
      null,
      2_000
    )
    const staleCredentials = createClaudeCredentialsJson('user@example.com', 'stale', null, 1_000)
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createClaudeAccount('account-1', managedAuthPath, { managedAuthRuntime: 'host' })
        ],
        activeClaudeManagedAccountId: 'account-1'
      })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    await service.prepareForClaudeLaunch()
    setScopedKeychainCredentialsForManagedPath(managedAuthPath, staleCredentials)
    await service.prepareForClaudeLaunch()

    expect(testState.managedKeychainCredentials.get('account-1')).toBe(managedCredentials)
    expect(testState.scopedKeychainCredentials).toBe(managedCredentials)
  })

  // Why: real credential blobs carry no identity fields, so identity can only come from the
  // .claude.json the CLI keeps inside the config dir those credentials belong to.
  it('adopts a rotated scoped credential proven by the managed config dir identity', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const managedCredentials = createClaudeCredentialsWithoutEmail('managed', null, {
      expiresAt: 2_000,
      refreshToken: 'managed-refresh'
    })
    const rotatedCredentials = createClaudeCredentialsWithoutEmail('rotated', null, {
      expiresAt: 3_000,
      refreshToken: 'rotated-refresh'
    })
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    writeFileSync(
      join(managedAuthPath, '.claude.json'),
      JSON.stringify({
        oauthAccount: { accountUuid: 'account-1', emailAddress: 'user@example.com' }
      }),
      'utf-8'
    )
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createClaudeAccount('account-1', managedAuthPath, { managedAuthRuntime: 'host' })
        ],
        activeClaudeManagedAccountId: 'account-1'
      })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    await service.prepareForClaudeLaunch()
    setScopedKeychainCredentialsForManagedPath(managedAuthPath, rotatedCredentials)
    await service.prepareForClaudeLaunch()

    expect(testState.managedKeychainCredentials.get('account-1')).toBe(rotatedCredentials)
  })

  // Why: a stale shared .claude.json left by migration must not vouch for a different login that
  // happened inside the managed pane.
  it('rejects a scoped credential whose managed config dir identity is a different account', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const managedCredentials = createClaudeCredentialsWithoutEmail('managed', null, {
      expiresAt: 2_000,
      refreshToken: 'managed-refresh'
    })
    const foreignCredentials = createClaudeCredentialsWithoutEmail('foreign', null, {
      expiresAt: 3_000,
      refreshToken: 'foreign-refresh'
    })
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    writeFileSync(
      join(testState.fakeHomeDir, '.claude.json'),
      JSON.stringify({
        oauthAccount: { accountUuid: 'account-1', emailAddress: 'user@example.com' }
      }),
      'utf-8'
    )
    writeFileSync(
      join(managedAuthPath, '.claude.json'),
      JSON.stringify({
        oauthAccount: { accountUuid: 'account-2', emailAddress: 'other@example.com' }
      }),
      'utf-8'
    )
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createClaudeAccount('account-1', managedAuthPath, { managedAuthRuntime: 'host' })
        ],
        activeClaudeManagedAccountId: 'account-1'
      })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    await service.prepareForClaudeLaunch()
    setScopedKeychainCredentialsForManagedPath(managedAuthPath, foreignCredentials)
    await service.prepareForClaudeLaunch()

    expect(testState.managedKeychainCredentials.get('account-1')).toBe(managedCredentials)
  })

  // Why: a pane that never reached the managed home runs the personal login; labelling it
  // `managed:` hid that from the usage lane, which then reported personal numbers as the account's.
  it('does not claim managed provenance when the managed auth dir is unusable', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const credentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const managedAuthPath = createManagedClaudeAuth(testState.userDataDir, 'account-1', credentials)
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createClaudeAccount('account-1', managedAuthPath, { managedAuthRuntime: 'host' })
        ],
        activeClaudeManagedAccountId: 'account-1'
      })
    )
    // The account's auth dir is gone (cleanup tool, backup restore).
    rmSync(managedAuthPath, { recursive: true, force: true })
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    const preparation = await service.prepareForClaudeLaunch()

    expect(preparation.provenance).toBe('system:managed-auth-unowned')
    expect(preparation.configDir).toBe(expectedRuntimeConfigDir())
    expect(preparation.envPatch.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  // Why: during a Keychain outage the CLI persists rotations to the home's credentials file, so
  // recovery must adopt that rotation instead of re-imposing the token it has already spent.
  it('adopts a rotation the CLI wrote to the managed credentials file during an outage', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const staleCredentials = createClaudeCredentialsWithoutEmail('stale', null, {
      expiresAt: 2_000,
      refreshToken: 'stale-refresh'
    })
    const rotatedCredentials = createClaudeCredentialsWithoutEmail('rotated', null, {
      expiresAt: 3_000,
      refreshToken: 'rotated-refresh'
    })
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      staleCredentials
    )
    writeFileSync(
      join(managedAuthPath, '.claude.json'),
      JSON.stringify({
        oauthAccount: { accountUuid: 'account-1', emailAddress: 'user@example.com' }
      }),
      'utf-8'
    )
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createClaudeAccount('account-1', managedAuthPath, { managedAuthRuntime: 'host' })
        ],
        activeClaudeManagedAccountId: 'account-1'
      })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    await service.prepareForClaudeLaunch()
    // The Keychain was unusable, so the CLI rotated into the home's credentials file.
    writeFileSync(join(managedAuthPath, '.credentials.json'), rotatedCredentials, 'utf-8')

    await service.prepareForClaudeLaunch()

    expect(testState.managedKeychainCredentials.get('account-1')).toBe(rotatedCredentials)
    expect(testState.scopedKeychainCredentialsByConfigDir.get(realpathSync(managedAuthPath))).toBe(
      rotatedCredentials
    )
    // Keychain is authoritative again; the fallback file must not linger.
    expect(existsSync(join(managedAuthPath, '.credentials.json'))).toBe(false)
  })

  // Why: a torn .claude.json makes identity unprovable; the CLI's newer rotation must still not be
  // overwritten with an already-consumed refresh token.
  it('does not overwrite a fresher scoped credential when identity cannot be proven', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const managedCredentials = createClaudeCredentialsWithoutEmail('managed', null, {
      expiresAt: 2_000,
      refreshToken: 'managed-refresh'
    })
    const rotatedCredentials = createClaudeCredentialsWithoutEmail('rotated', null, {
      expiresAt: 3_000,
      refreshToken: 'rotated-refresh'
    })
    const managedAuthPath = createManagedClaudeAuth(
      testState.userDataDir,
      'account-1',
      managedCredentials
    )
    // A torn write of the CLI's own state file: identity becomes unprovable.
    writeFileSync(join(managedAuthPath, '.claude.json'), '{"oauthAccount":', 'utf-8')
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createClaudeAccount('account-1', managedAuthPath, { managedAuthRuntime: 'host' })
        ],
        activeClaudeManagedAccountId: 'account-1'
      })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)

    await service.prepareForClaudeLaunch()
    setScopedKeychainCredentialsForManagedPath(managedAuthPath, rotatedCredentials)
    await service.prepareForClaudeLaunch()

    expect(testState.scopedKeychainCredentialsByConfigDir.get(realpathSync(managedAuthPath))).toBe(
      rotatedCredentials
    )
  })

  // Why: precedent is to degrade the storage medium, never the account identity.
  it('keeps the managed home and writes its credentials file when the scoped Keychain fails', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const credentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const managedAuthPath = createManagedClaudeAuth(testState.userDataDir, 'account-1', credentials)
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createClaudeAccount('account-1', managedAuthPath, { managedAuthRuntime: 'host' })
        ],
        activeClaudeManagedAccountId: 'account-1'
      })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    // Setup seeds this file; drop it so the write below is observed, not assumed.
    rmSync(join(managedAuthPath, '.credentials.json'), { force: true })
    testState.throwScopedKeychainWrite = true

    const preparation = await service.prepareForClaudeLaunch()

    expect(preparation.provenance).toBe('managed:account-1')
    expect(preparation.stripAuthEnv).toBe(true)
    expect(preparation.configDir).toBe(realpathSync(managedAuthPath))
    expect(readFileSync(join(managedAuthPath, '.credentials.json'), 'utf-8')).toBe(credentials)
  })

  // Why: a locked Keychain is recoverable, so it must never cause a plaintext credential spill.
  it('does not write a credentials file when the Keychain failure is transient', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const credentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const managedAuthPath = createManagedClaudeAuth(testState.userDataDir, 'account-1', credentials)
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createClaudeAccount('account-1', managedAuthPath, { managedAuthRuntime: 'host' })
        ],
        activeClaudeManagedAccountId: 'account-1'
      })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    rmSync(join(managedAuthPath, '.credentials.json'), { force: true })
    testState.throwScopedKeychainWrite = true
    testState.scopedKeychainWriteErrorMessage = 'User interaction is not allowed.'

    const preparation = await service.prepareForClaudeLaunch()

    expect(preparation.provenance).toBe('system:managed-keychain-unavailable')
    expect(existsSync(join(managedAuthPath, '.credentials.json'))).toBe(false)
  })

  it('retains a visible degraded provenance after scoped Keychain bridge failure', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const credentials = createClaudeCredentialsJson('user@example.com', 'managed')
    const managedAuthPath = createManagedClaudeAuth(testState.userDataDir, 'account-1', credentials)
    const store = createStore(
      createSettings({
        claudeManagedAccounts: [
          createClaudeAccount('account-1', managedAuthPath, { managedAuthRuntime: 'host' })
        ],
        activeClaudeManagedAccountId: 'account-1'
      })
    )
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const service = new ClaudeRuntimeAuthService(store as never)
    testState.throwScopedKeychainWrite = true
    testState.throwManagedKeychainRead = true

    const launchPreparation = await service.prepareForClaudeLaunch()
    expect(launchPreparation.provenance).toBe('system:managed-keychain-unavailable')

    testState.throwScopedKeychainWrite = false
    testState.throwManagedKeychainRead = false
    await expect(service.prepareForRateLimitFetch()).resolves.toMatchObject({
      provenance: 'system:managed-keychain-unavailable',
      stripAuthEnv: false
    })

    await service.prepareForClaudeLaunch()
    await expect(service.prepareForRateLimitFetch()).resolves.toMatchObject({
      provenance: 'managed:account-1',
      stripAuthEnv: true
    })
  })
})
