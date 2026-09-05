import { describe, expect, it, vi } from 'vitest'
import type { WorktreeTerminalProvisioningHost } from './runtime-worktree-terminal-provisioning'
import { provisionWorktreeTerminals } from './runtime-worktree-terminal-provisioning'

function fixture(mode: 'new-tab' | 'split-horizontal') {
  const host = {
    canSpawn: () => true,
    createTerminal: vi.fn<WorktreeTerminalProvisioningHost['createTerminal']>(async () => ({
      handle: 'primary'
    })),
    splitTerminal: vi.fn<WorktreeTerminalProvisioningHost['splitTerminal']>(async () => ({
      handle: 'setup'
    })),
    setTabColor: vi.fn(async () => {}),
    getSettings: () => ({
      setupScriptLaunchMode: mode,
      workspaceDir: '/workspace',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: true,
      branchPrefix: 'none' as const,
      branchPrefixCustom: ''
    }),
    getPtyId: () => undefined,
    recordSetupCompletionToken: vi.fn()
  }
  return host
}

describe('background worktree terminal provisioning', () => {
  it.each(['new-tab', 'split-horizontal'] as const)(
    'provisions %s setup once without selecting tabs',
    async (mode) => {
      const host = fixture(mode)
      const result = await provisionWorktreeTerminals(host, {
        worktreeSelector: 'id:workspace',
        worktreeId: 'workspace',
        worktreePath: '/workspace',
        setup: { runnerScriptPath: '/workspace/setup.sh', envVars: {} },
        defaultTabs: { tabs: [{ title: 'Logs' }], runCommands: false },
        hasStartupTerminal: false,
        setupCommandPlatform: 'posix',
        surfaceOwner: false
      })
      expect(result.setupSpawned).toBe(true)
      expect(host.createTerminal).toHaveBeenCalledTimes(mode === 'new-tab' ? 2 : 1)
      expect(host.splitTerminal).toHaveBeenCalledTimes(mode === 'new-tab' ? 0 : 1)
      for (const [, options] of [
        ...host.createTerminal.mock.calls,
        ...host.splitTerminal.mock.calls
      ]) {
        expect(options).toMatchObject({ surfaceOwner: false, activate: false })
      }
    }
  )

  it.each([false, undefined] as const)(
    'preserves primary-terminal selection contract for surfaceOwner=%s',
    async (surfaceOwner) => {
      const host = fixture('new-tab')
      await provisionWorktreeTerminals(host, {
        worktreeSelector: 'id:workspace',
        worktreeId: 'workspace',
        worktreePath: '/workspace',
        hasStartupTerminal: false,
        setupCommandPlatform: 'posix',
        surfaceOwner
      })
      expect(host.createTerminal).toHaveBeenCalledExactlyOnceWith(
        'id:workspace',
        surfaceOwner === false ? { surfaceOwner: false, activate: false } : {}
      )
    }
  )
})
