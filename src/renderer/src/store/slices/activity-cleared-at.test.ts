import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { RetainedAgentEntry } from './agent-status'
import { createTestStore } from './store-test-helpers'

function makeRetained(paneKey: string, worktreeId = 'wt-1'): RetainedAgentEntry {
  const entry: AgentStatusEntry = {
    state: 'done',
    prompt: 'run',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    paneKey,
    stateHistory: [],
    agentType: 'claude'
  }
  const tab: TerminalTab = {
    id: paneKey.split(':')[0],
    ptyId: 'pty-1',
    worktreeId,
    title: 'agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  return { entry, worktreeId, tab, agentType: 'claude', startedAt: 1_000 }
}

describe('applyActivityClearedAt', () => {
  it('merges stamps, deletes on null, and no-ops on identical patches', () => {
    const store = createTestStore()
    store.getState().applyActivityClearedAt({ 'a:1': 100, 'b:2': 200 })
    expect(store.getState().activityClearedAtByPaneKey).toEqual({ 'a:1': 100, 'b:2': 200 })

    const before = store.getState().activityClearedAtByPaneKey
    store.getState().applyActivityClearedAt({ 'a:1': 100 })
    // Identity preserved when nothing changed, so subscribers don't churn.
    expect(store.getState().activityClearedAtByPaneKey).toBe(before)

    store.getState().applyActivityClearedAt({ 'a:1': null })
    expect(store.getState().activityClearedAtByPaneKey).toEqual({ 'b:2': 200 })

    const afterDelete = store.getState().activityClearedAtByPaneKey
    store.getState().applyActivityClearedAt({ missing: null })
    expect(store.getState().activityClearedAtByPaneKey).toBe(afterDelete)
  })
})

describe('dismissRetainedAgents', () => {
  it('removes the named retained entries in one update and leaves others intact', () => {
    const store = createTestStore()
    store
      .getState()
      .retainAgents([makeRetained('tab-a:1'), makeRetained('tab-b:2'), makeRetained('tab-c:3')])
    store.getState().dismissRetainedAgents(['tab-a:1', 'tab-c:3', 'tab-unknown:9'])
    expect(Object.keys(store.getState().retainedAgentsByPaneKey)).toEqual(['tab-b:2'])
  })

  it('plants a retention suppressor only for panes that still have a live entry', () => {
    const store = createTestStore()
    store.getState().retainAgents([makeRetained('tab-a:1'), makeRetained('tab-b:2')])
    store.setState({
      agentStatusByPaneKey: {
        'tab-a:1': {
          state: 'done',
          prompt: 'live',
          updatedAt: 2_000,
          stateStartedAt: 2_000,
          paneKey: 'tab-a:1',
          stateHistory: [],
          agentType: 'claude'
        }
      }
    })
    store.getState().dismissRetainedAgents(['tab-a:1', 'tab-b:2'])
    expect(store.getState().retainedAgentsByPaneKey).toEqual({})
    // Live pane gets a one-shot suppressor; the gone pane must NOT (undo re-retains it cleanly).
    expect(store.getState().retentionSuppressedPaneKeys['tab-a:1']).toBe(true)
    expect(store.getState().retentionSuppressedPaneKeys['tab-b:2']).toBeUndefined()
  })

  it('no-ops without reallocation when nothing matches', () => {
    const store = createTestStore()
    store.getState().retainAgents([makeRetained('tab-a:1')])
    const before = store.getState().retainedAgentsByPaneKey
    store.getState().dismissRetainedAgents(['tab-zz:9'])
    expect(store.getState().retainedAgentsByPaneKey).toBe(before)
  })
})
