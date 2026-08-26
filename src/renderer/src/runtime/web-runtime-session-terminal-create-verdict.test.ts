import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebRuntimeSessionTerminal } from './web-runtime-session'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  WORKTREE_ID,
  makeSnapshot,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from './web-runtime-session-test-harness'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyWebSessionTabsSnapshot: vi.fn(),
  decideWebSessionTabsSnapshot: vi.fn(() => ({
    apply: true,
    settlesHostMirror: true
  })),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot,
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    return () => {}
  },
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

afterEach(() => resetWebSessionCloseIntentForTests())

describe('createWebRuntimeSessionTerminal create verdict', () => {
  beforeEach(() => {
    stubTerminalCreateEnvironment(mocks)
  })

  afterEach(() => {
    resetTerminalCreateEnvironment()
  })

  it('reports a lost reply as unverifiable rather than a definite failure', async () => {
    // Why: transport errors reject; the host may already have created the PTY.
    const runtimeCall = vi.fn().mockRejectedValue(new Error('runtime call timed out'))
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      activate: true
    })

    expect(outcome).toEqual({
      status: 'unverifiable',
      message: 'runtime call timed out'
    })
  })

  it('reports a host rejection with a definitive code as failed', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'create-terminal',
      ok: false,
      error: { code: 'invalid_params', message: 'worktree is required' }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      activate: true
    })

    expect(outcome).toEqual({
      status: 'failed',
      message: 'worktree is required'
    })
  })

  it('reports a pre-call manual-disconnect envelope as failed, not unverifiable', async () => {
    // Why: the main handler and both web preload call paths return this envelope BEFORE dispatching,
    // so the request never left the client and no PTY can exist.
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'runtime.manualDisconnect',
      ok: false,
      error: {
        code: 'runtime_manually_disconnected',
        message: 'Runtime environment is manually disconnected.'
      }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      activate: true
    })

    expect(outcome).toEqual({
      status: 'failed',
      message: 'Runtime environment is manually disconnected.'
    })
  })

  it('reports a post-reply manual-disconnect substitution as unverifiable', async () => {
    // Why: this envelope replaces a reply the client already received, so the discarded reply may
    // have been `ok:true` — indistinguishable from a create the host completed.
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'runtime.manualDisconnect',
      ok: false,
      error: {
        code: 'runtime_manually_disconnected_after_reply',
        message: 'Runtime environment is manually disconnected.'
      }
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      activate: true
    })

    expect(outcome.status).toBe('unverifiable')
  })

  it('reports a re-wrapped refusal token as failed when the transport dropped the cause', async () => {
    // Why: Electron IPC/relay re-wrap the reply into a plain message and drop the cause
    // (runtime-rpc-result.ts), so the code token in the text is the only surviving proof.
    const runtimeCall = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Error invoking remote method 'runtimeEnvironments:call': Error: selector_not_found"
        )
      )
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      activate: true
    })

    expect(outcome.status).toBe('failed')
  })

  it('still reports created when the host confirmed and only reconciliation failed', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create-terminal',
        ok: true,
        result: {
          tab: { id: 'host-tab-2::leaf-1', leafId: 'leaf-1' },
          publicationEpoch: 'epoch-1',
          snapshotVersion: 2
        }
      })
      .mockRejectedValueOnce(new Error('snapshot refresh timed out'))
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })
    mocks.applyWebSessionTabsSnapshot.mockReturnValue(makeSnapshot())

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      activate: true
    })

    expect(outcome).toEqual({ status: 'created' })
  })
})
