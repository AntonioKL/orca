import { describe, expect, it } from 'vitest'
import { createTestStore, makeTab } from './store-test-helpers'

const PANE_KEY = 'tab-1:leaf-1'
const AGENT_SUBDIRECTORY = '/repo/wt-1/packages/api'

describe('agent working directory on status entries and sleeping records (STA-5804)', () => {
  it('stamps the directory the hook reported onto the sleeping record', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .recordAgentProviderSession(
        PANE_KEY,
        'claude',
        providerSession,
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY }
      )

    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]
    expect(record?.agentCwd).toBe(AGENT_SUBDIRECTORY)
    // The pane's worktree binding is unchanged — the directory is additional, not a substitute.
    expect(record?.worktreeId).toBe('wt-1')
  })

  it('leaves the directory unknown when the hook reported none', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })

    store
      .getState()
      .recordAgentProviderSession(
        PANE_KEY,
        'claude',
        { key: 'session_id', id: 'claude-session-1' },
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )

    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]
    expect(record).toBeDefined()
    expect(record?.agentCwd).toBeUndefined()
  })

  it('keeps the directory across later events for the same session that omit it', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .recordAgentProviderSession(
        PANE_KEY,
        'claude',
        providerSession,
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY }
      )
    store.getState().recordAgentProviderSession(
      PANE_KEY,
      'claude',
      providerSession,
      { updatedAt: 20 },
      {
        tabId: 'tab-1',
        worktreeId: 'wt-1'
      }
    )

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.agentCwd).toBe(
      AGENT_SUBDIRECTORY
    )
  })

  it('drops the directory when the pane starts a different provider session', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })

    store
      .getState()
      .recordAgentProviderSession(
        PANE_KEY,
        'claude',
        { key: 'session_id', id: 'claude-session-1' },
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY }
      )
    store.getState().recordAgentProviderSession(
      PANE_KEY,
      'claude',
      { key: 'session_id', id: 'claude-session-2' },
      {
        updatedAt: 20
      },
      { tabId: 'tab-1', worktreeId: 'wt-1' }
    )

    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]
    expect(record?.providerSession.id).toBe('claude-session-2')
    expect(record?.agentCwd).toBeUndefined()
  })

  it('carries a live status row directory into the record the status write derives', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'refactor the parser', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY },
        { providerSession }
      )

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.agentCwd).toBe(AGENT_SUBDIRECTORY)
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.agentCwd).toBe(
      AGENT_SUBDIRECTORY
    )
  })
  it('drops the directory when a live pane switches to a different provider session', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'refactor the parser', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY },
        { providerSession: { key: 'session_id', id: 'claude-session-1' } }
      )
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'a different job', agentType: 'claude' },
        'Claude',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: { key: 'session_id', id: 'claude-session-2' } }
      )

    const entry = store.getState().agentStatusByPaneKey[PANE_KEY]
    expect(entry?.providerSession?.id).toBe('claude-session-2')
    expect(entry?.agentCwd).toBeUndefined()
  })

  it('keeps the directory across a same-session status update that omits it', () => {
    const store = createTestStore()
    store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'refactor the parser', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', agentCwd: AGENT_SUBDIRECTORY },
        { providerSession }
      )
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'refactor the parser', agentType: 'claude' },
        'Claude',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.agentCwd).toBe(AGENT_SUBDIRECTORY)
  })
})
