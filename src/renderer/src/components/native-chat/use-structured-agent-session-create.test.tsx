// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { PreloadApi } from '../../../../preload/api-types'
import { useStructuredAgentSessionCreate } from './use-structured-agent-session-create'

const platformMock = vi.hoisted(() => ({
  fn: vi.fn<() => NodeJS.Platform>(() => 'darwin')
}))

vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: platformMock.fn
}))

const runtimeClientMock = vi.hoisted(() => ({
  getActiveRuntimeTarget: vi.fn(
    ({ activeRuntimeEnvironmentId }: { activeRuntimeEnvironmentId: string | null }) =>
      activeRuntimeEnvironmentId
        ? { kind: 'environment' as const, environmentId: activeRuntimeEnvironmentId }
        : { kind: 'local' as const }
  ),
  runtimeEnvironmentSupportsCapability: vi.fn(async () => true)
}))

vi.mock('@/runtime/runtime-rpc-client', () => runtimeClientMock)

const callStructuredAgentSessionMock = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: callStructuredAgentSessionMock
}))

const storeState: { current: AppState } = {
  current: {} as AppState
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: AppState) => unknown) => selector(storeState.current),
    {
      getState: () => storeState.current
    }
  )
}))

vi.mock('@/runtime/web-session-focus-intent', () => ({
  recordWebSessionFocusIntent: vi.fn()
}))

function buildState(overrides: Partial<AppState['settings']> = {}): AppState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'wt-1',
    repos: [{ id: 'repo-1', connectionId: null, path: '/repo' }],
    projects: [
      {
        id: 'repo-1',
        localWindowsRuntimePreference: { kind: 'inherit-global' as const }
      }
    ],
    worktreesByRepo: {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          projectId: 'repo-1',
          path: '/repo/worktree'
        }
      ]
    },
    detectedWorktreesByRepo: {},
    settings: {
      experimentalNativeChat: true,
      experimentalStructuredNativeChat: true,
      openAgentTabsInChatByDefault: true,
      ...overrides
    }
  } as unknown as AppState
}

describe('useStructuredAgentSessionCreate', () => {
  let previousApi: Pick<PreloadApi, 'runtime'> | undefined

  beforeEach(() => {
    platformMock.fn.mockReturnValue('darwin')
    runtimeClientMock.getActiveRuntimeTarget.mockClear()
    runtimeClientMock.runtimeEnvironmentSupportsCapability.mockClear()
    callStructuredAgentSessionMock.mockReset()
    callStructuredAgentSessionMock.mockImplementation(async (_target, method) => {
      if (method === 'agentSession.createSupport') {
        return { supported: true }
      }
      if (method === 'agentSession.create') {
        return { ok: true, replayed: false, value: { sessionId: 'session-1' } }
      }
      throw new Error(`unexpected method ${method as string}`)
    })
    const windowWithApi = window as unknown as { api?: Pick<PreloadApi, 'runtime'> }
    previousApi = windowWithApi.api
    windowWithApi.api = {
      runtime: {
        getStatus: vi.fn(
          async () =>
            ({
              capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
            }) as unknown as never
        )
      } as unknown as PreloadApi['runtime']
    }
    storeState.current = buildState()
  })

  afterEach(() => {
    ;(window as unknown as { api?: Pick<PreloadApi, 'runtime'> }).api = previousApi
  })

  it('keeps the chat-session action off when structured native chat is disabled', async () => {
    storeState.current = buildState({ experimentalStructuredNativeChat: false })
    const hook = renderHook(() => useStructuredAgentSessionCreate('wt-1', 'claude'))

    await waitFor(() => expect(hook.result.current.supported).toBe(false))
    expect(callStructuredAgentSessionMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'agentSession.createSupport',
      expect.anything()
    )
    await expect(hook.result.current.create()).resolves.toBe(false)
  })

  it('drops a stale support result when the structured toggle turns off', async () => {
    const hook = renderHook(() => useStructuredAgentSessionCreate('wt-1', 'claude'))

    await waitFor(() => expect(hook.result.current.supported).toBe(true))
    expect(callStructuredAgentSessionMock).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.createSupport',
      expect.objectContaining({ worktree: 'id:wt-1', agent: 'claude' })
    )

    act(() => {
      storeState.current = buildState({ experimentalStructuredNativeChat: false })
      hook.rerender()
    })

    await waitFor(() => expect(hook.result.current.supported).toBe(false))
    await expect(hook.result.current.create()).resolves.toBe(false)
  })

  it('refuses Windows local support until creation-time proof exists', async () => {
    platformMock.fn.mockReturnValue('win32')
    storeState.current = buildState()
    const hook = renderHook(() => useStructuredAgentSessionCreate('wt-1', 'claude'))

    await waitFor(() => expect(hook.result.current.supported).toBe(false))
    expect(callStructuredAgentSessionMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'agentSession.createSupport',
      expect.anything()
    )
  })
})
