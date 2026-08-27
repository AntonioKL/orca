import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexConfigMirror from '../codex/codex-config-mirror'
import type * as CodexHomePaths from '../codex/codex-home-paths'
import type * as WslCodexSessionBridge from '../codex/wsl-codex-session-bridge'
import type * as LegacyWslRuntimeAuthDrain from './legacy-wsl-runtime-auth-drain'
import type * as WslCodexAuthBatchReader from './wsl-codex-auth-batch-reader'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('CodexRuntimeHomeService retired WSL session launch bridge', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    teardownRuntimeHomeTest()
  })

  it.skipIf(process.platform === 'win32')(
    'links retired sessions only when auth authorizes the launched direct home',
    async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const guestHome = join(testState.userDataDir, 'ubuntu-home')
      const wslHome = `\\\\wsl.localhost\\Ubuntu${guestHome.replaceAll('/', '\\')}`
      vi.doMock('../wsl', () => ({
        getDefaultWslDistro: () => 'Ubuntu',
        getWslHome: () => wslHome
      }))
      const ownerAuth = createCodexAuthJson(
        'owner@example.com',
        'acct-owner',
        'owner-refresh',
        2_000
      )
      const otherAuth = createCodexAuthJson(
        'other@example.com',
        'acct-other',
        'other-refresh',
        2_000
      )
      const ownerHome = createManagedAuth(testState.userDataDir, 'owner', ownerAuth)
      const otherHome = createManagedAuth(testState.userDataDir, 'other', otherAuth)
      vi.doMock('./wsl-codex-auth-batch-reader', async (importOriginal) => ({
        ...(await importOriginal<typeof WslCodexAuthBatchReader>()),
        readWslCodexAuths: vi.fn(async (_distro: string, homes: string[]) =>
          homes.map((home) => {
            if (home === ownerHome) {
              return { kind: 'present' as const, contents: ownerAuth }
            }
            if (home === otherHome) {
              return { kind: 'present' as const, contents: otherAuth }
            }
            return { kind: 'missing' as const }
          })
        )
      }))
      vi.doMock('../wsl/wsl-runner', () => ({
        runWslProcess: vi.fn(
          async (options: { args?: string[]; script: string; shell?: 'bash' }) => {
            try {
              const stdout = execFileSync(options.shell === 'bash' ? '/bin/bash' : '/bin/sh', [
                '-c',
                options.script,
                options.shell ?? 'sh',
                ...(options.args ?? [])
              ]).toString()
              return {
                code: 0,
                stdout,
                stderr: '',
                timedOut: false,
                environmentResolved: true
              }
            } catch (error) {
              return {
                code: (error as { status?: number }).status ?? 1,
                stdout: (error as { stdout?: Buffer }).stdout?.toString() ?? '',
                stderr: (error as { stderr?: Buffer }).stderr?.toString() ?? '',
                timedOut: false,
                environmentResolved: true
              }
            }
          }
        )
      }))
      let drainResult: 'authorized' | 'failed-apply' | 'skipped' = 'authorized'
      vi.doMock('./legacy-wsl-runtime-auth-drain', () => ({
        startLegacyWslRuntimeAuthDrain: vi.fn(
          async (
            options: Parameters<typeof LegacyWslRuntimeAuthDrain.startLegacyWslRuntimeAuthDrain>[0]
          ) => {
            if (drainResult === 'skipped') {
              return
            }
            const destination = await options.resolveDestination(ownerAuth)
            if (drainResult === 'authorized' && destination) {
              options.onDestinationAuthorized?.(destination)
            }
          }
        )
      }))
      const bridgeTasks: Promise<void>[] = []
      vi.doMock('../codex/wsl-codex-session-bridge', async (importOriginal) => {
        const actual = await importOriginal<typeof WslCodexSessionBridge>()
        return {
          ...actual,
          startWslCodexSessionBridgeInBackground: (
            target: Parameters<typeof actual.startWslCodexSessionBridgeInBackground>[0]
          ) => {
            const task = actual.startWslCodexSessionBridgeInBackground(target)
            bridgeTasks.push(task)
            return task
          }
        }
      })
      vi.doMock('../codex/codex-home-paths', async (importOriginal) => ({
        ...(await importOriginal<typeof CodexHomePaths>()),
        syncCodexGlobalInstructionsIntoManagedHome: vi.fn()
      }))
      vi.doMock('../codex/codex-config-mirror', async (importOriginal) => ({
        ...(await importOriginal<typeof CodexConfigMirror>()),
        syncSystemConfigIntoManagedCodexHome: vi.fn()
      }))
      const retiredHome = join(guestHome, '.local', 'share', 'orca', 'codex-runtime-home', 'home')
      const relativeSessionPath = join('sessions', '2026', '08', '27', 'retired.jsonl')
      const retiredSessionPath = join(retiredHome, relativeSessionPath)
      mkdirSync(join(retiredSessionPath, '..'), { recursive: true })
      writeFileSync(join(retiredHome, 'auth.json'), ownerAuth, 'utf-8')
      writeFileSync(retiredSessionPath, '{"session":"retired"}\n', 'utf-8')
      const account = (
        id: string,
        email: string,
        managedHomePath: string,
        providerAccountId: string,
        createdAt: number
      ) => ({
        id,
        email,
        managedHomePath,
        managedHomeRuntime: 'wsl' as const,
        wslDistro: 'Ubuntu',
        wslLinuxHomePath: managedHomePath,
        providerAccountId,
        workspaceLabel: null,
        workspaceAccountId: providerAccountId,
        createdAt,
        updatedAt: createdAt,
        lastAuthenticatedAt: createdAt
      })
      const store = createStore(
        createSettings({
          codexManagedAccounts: [
            account('owner', 'owner@example.com', ownerHome, 'acct-owner', 1),
            account('other', 'other@example.com', otherHome, 'acct-other', 2)
          ],
          activeCodexManagedAccountIdsByRuntime: {
            host: null,
            wsl: { Ubuntu: 'other' }
          }
        })
      )

      try {
        const { CodexRuntimeHomeService } = await import('./runtime-home-service')
        const service = new CodexRuntimeHomeService(store as never)
        const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
        const ownerSessionPath = join(ownerHome, relativeSessionPath)
        const otherSessionPath = join(otherHome, relativeSessionPath)

        await service.prepareForCodexLaunchAsync(target)
        await Promise.all(bridgeTasks.splice(0))
        expect(existsSync(ownerSessionPath)).toBe(false)
        expect(existsSync(otherSessionPath)).toBe(false)

        store.updateSettings({
          activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'owner' } }
        })
        drainResult = 'skipped'
        await service.prepareForCodexLaunchAsync(target)
        await Promise.all(bridgeTasks.splice(0))
        expect(existsSync(ownerSessionPath)).toBe(false)

        store.updateSettings({
          activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'other' } }
        })
        drainResult = 'authorized'
        await service.prepareForCodexLaunchAsync(target)
        await Promise.all(bridgeTasks.splice(0))
        expect(existsSync(ownerSessionPath)).toBe(false)

        store.updateSettings({
          activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'owner' } }
        })
        drainResult = 'failed-apply'
        await service.prepareForCodexLaunchAsync(target)
        await Promise.all(bridgeTasks.splice(0))
        expect(existsSync(ownerSessionPath)).toBe(false)

        drainResult = 'authorized'
        await service.prepareForCodexLaunchAsync(target)
        await Promise.all(bridgeTasks.splice(0))
        expect(readFileSync(ownerSessionPath, 'utf-8')).toBe('{"session":"retired"}\n')
        expect(statSync(ownerSessionPath).ino).toBe(statSync(retiredSessionPath).ino)
        expect(existsSync(otherSessionPath)).toBe(false)

        const linkedInode = statSync(ownerSessionPath).ino
        await service.prepareForCodexLaunchAsync(target)
        await Promise.all(bridgeTasks.splice(0))
        expect(statSync(ownerSessionPath).ino).toBe(linkedInode)

        rmSync(ownerSessionPath)
        rmSync(retiredHome, { recursive: true })
        await service.prepareForCodexLaunchAsync(target)
        await Promise.all(bridgeTasks.splice(0))
        expect(existsSync(ownerSessionPath)).toBe(false)
      } finally {
        vi.doUnmock('../codex/codex-config-mirror')
        vi.doUnmock('../codex/codex-home-paths')
        vi.doUnmock('../codex/wsl-codex-session-bridge')
        vi.doUnmock('./legacy-wsl-runtime-auth-drain')
        vi.doUnmock('./wsl-codex-auth-batch-reader')
        vi.doUnmock('../wsl/wsl-runner')
        vi.doUnmock('../wsl')
        if (originalPlatform) {
          Object.defineProperty(process, 'platform', originalPlatform)
        }
      }
    }
  )
})
