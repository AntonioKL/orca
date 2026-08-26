import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { canUseStructuredNativeChat } from './structured-native-chat-availability'

const { mockGetRendererAppPlatform } = vi.hoisted(() => ({
  mockGetRendererAppPlatform: vi.fn<() => NodeJS.Platform>(() => 'darwin')
}))

vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: mockGetRendererAppPlatform
}))

function stateFor(input: {
  connectionId?: string | null
  windowsRuntime?: 'windows-host' | 'wsl'
  worktreePath?: string
}): AppState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'wt-1',
    projects: [
      {
        id: 'repo-1',
        localWindowsRuntimePreference:
          input.windowsRuntime === 'wsl'
            ? { kind: 'wsl', distro: 'Ubuntu' }
            : { kind: 'windows-host' }
      }
    ],
    repos: [{ id: 'repo-1', connectionId: input.connectionId ?? null, path: 'C:\\repo' }],
    settings: { experimentalStructuredNativeChat: true },
    worktreesByRepo: {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          projectId: 'repo-1',
          path: input.worktreePath ?? 'C:\\repo\\worktree'
        }
      ]
    },
    detectedWorktreesByRepo: {}
  } as unknown as AppState
}

describe('canUseStructuredNativeChat', () => {
  beforeEach(() => {
    mockGetRendererAppPlatform.mockReturnValue('darwin')
  })

  it('allows the structured stack on a local worktree', () => {
    expect(canUseStructuredNativeChat(stateFor({}), 'wt-1')).toBe(true)
  })

  it('keeps the legacy bridge when the updated runtime is opted out', () => {
    expect(
      canUseStructuredNativeChat(
        { ...stateFor({}), settings: { experimentalStructuredNativeChat: false } } as AppState,
        'wt-1'
      )
    ).toBe(false)
  })

  it('refuses an SSH worktree so the pane stays on the bridge', () => {
    expect(canUseStructuredNativeChat(stateFor({ connectionId: 'ssh-a' }), 'wt-1')).toBe(false)
  })

  it('refuses a runtime-paired worktree so the pane stays on the bridge', () => {
    expect(canUseStructuredNativeChat(stateFor({ connectionId: 'runtime-ssh-a' }), 'wt-1')).toBe(
      false
    )
  })

  it('refuses a WSL project on Windows so the pane stays on the bridge', () => {
    mockGetRendererAppPlatform.mockReturnValue('win32')
    expect(canUseStructuredNativeChat(stateFor({ windowsRuntime: 'wsl' }), 'wt-1')).toBe(false)
  })

  it('keeps Windows-host projects on the terminal path until native start-time proof is advertised', () => {
    mockGetRendererAppPlatform.mockReturnValue('win32')
    expect(canUseStructuredNativeChat(stateFor({ windowsRuntime: 'windows-host' }), 'wt-1')).toBe(
      false
    )
  })
})
