import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// Why: the working→idle test invokes the real useNotificationDispatch hook outside React, so useCallback must pass through (safe suite-wide: no test here renders React).
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

// Why: stub only getEagerPtyBufferHandle so tests can simulate a live eager buffer (adopt path) without standing up the real IPC dispatcher.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

const RESTORED_PTY_ID = toAppSshPtyId('target-a', 'pty-from-dead-daemon')
const PROVIDER_SESSION = {
  key: 'session_id',
  id: 'codex-session-1',
  transcriptPath: '/Users/example/.codex/sessions/2026/07/20/rollout-session.jsonl'
} as const

function seedResumableSshPane(): void {
  const paneKey = makePaneKey('tab-1', LEAF_1)
  mockStoreState = {
    ...mockStoreState,
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', ptyId: RESTORED_PTY_ID }]
    },
    ptyIdsByTabId: { 'tab-1': [RESTORED_PTY_ID] },
    repos: [{ id: 'repo1', connectionId: 'target-a', displayName: 'orca' }],
    sshConnectionStates: new Map([
      ['target-a', { targetId: 'target-a', status: 'connected', connectionGeneration: 1 }]
    ]),
    settings: { ...mockStoreState.settings, agentCmdOverrides: {} },
    agentStatusByPaneKey: {
      [paneKey]: {
        state: 'working',
        prompt: 'finish the task',
        agentType: 'codex',
        paneKey,
        updatedAt: 1,
        stateStartedAt: 1,
        stateHistory: [],
        providerSession: PROVIDER_SESSION
      }
    }
  } as StoreState
}

/** Fails the reattach the way a relay that no longer knows the PTY does, then lets the
 *  fallback run. `expiry` is the exact message main surfaces for that absence. */
async function runAbsenceFallback(
  expiry: string
): Promise<{ transport: MockTransport; deps: ReturnType<typeof createDeps> }> {
  const { connectPanePty } = await import('./pty-connection')
  const transport = createMockTransport('fresh-pty')
  transport.connect
    .mockImplementationOnce(async (options: { callbacks?: ConnectCallbacks }) => {
      options.callbacks?.onError?.(expiry)
      return undefined
    })
    .mockResolvedValue('fresh-pty')
  transportFactoryQueue.push(transport)
  seedResumableSshPane()
  const deps = createDeps({
    restoredLeafId: LEAF_1,
    restoredPtyIdByLeafId: { [LEAF_1]: RESTORED_PTY_ID }
  })

  connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
  await flushAsyncTicks(20)
  await new Promise((resolve) => setTimeout(resolve, 70))
  return { transport, deps }
}

describe('absence fallback after a relay daemon replacement', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('still resumes the agent when the relay that answered predates the binding', async () => {
    const { transport, deps } = await runAbsenceFallback(`SSH_SESSION_EXPIRED: ${RESTORED_PTY_ID}`)

    expect(transport.connect).toHaveBeenCalledTimes(2)
    const freshSpawn = transport.connect.mock.calls[1]?.[0] as Record<string, unknown>
    expect(freshSpawn.sessionId).toBeUndefined()
    expect(freshSpawn.launchAgent).toBe('codex')
    expect(freshSpawn.resumeProviderSession).toEqual(PROVIDER_SESSION)
    expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalledWith(1, 'resume-unavailable')
  })

  it('spawns a plain shell instead of re-running the agent when the relay is younger than the binding', async () => {
    const { transport, deps } = await runAbsenceFallback(
      `SSH_SESSION_EXPIRED: ${RESTORED_PTY_ID} SSH_RELAY_REPLACED`
    )

    // The user still gets a terminal...
    expect(transport.connect).toHaveBeenCalledTimes(2)
    const freshSpawn = transport.connect.mock.calls[1]?.[0] as Record<string, unknown>
    expect(freshSpawn.sessionId).toBeUndefined()
    // ...but nothing that would start a second agent on the same worktree.
    expect(freshSpawn.launchAgent).toBeUndefined()
    expect(freshSpawn.resumeProviderSession).toBeUndefined()
    expect(freshSpawn.command).toBeUndefined()
    expect(freshSpawn.launchConfig).toBeUndefined()
    expect(freshSpawn.launchToken).toBeUndefined()
    // ...and the pane says the agent did not come back.
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'resume-unavailable')
  })
})
