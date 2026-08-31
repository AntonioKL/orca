import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { isChildAgentEntry, isChildAgentThread } from './activity-thread-child-agent'
import type { ActivityEvent, AgentPaneThread } from './activity-thread-types'
import {
  makeRepo,
  makeTabWithIds,
  makeWorkingEntryWithoutHistory,
  makeWorktree,
  PANE_KEY,
  PANE_KEY_2
} from './ActivityPrototypePage-test-fixtures'

function makeTestEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    ...makeWorkingEntryWithoutHistory(),
    paneKey: PANE_KEY,
    state: 'done',
    prompt: 'test prompt',
    stateHistory: [],
    ...overrides
  }
}

function makeTestThread(overrides: Partial<AgentPaneThread> = {}): AgentPaneThread {
  const repo = makeRepo()
  const worktree = makeWorktree()
  const tab = makeTabWithIds('tab-1', worktree.id)
  return {
    paneKey: PANE_KEY,
    paneTitle: 'Test Agent',
    agentType: 'claude',
    worktree,
    repo,
    tab,
    events: [],
    latestEvent: null,
    latestTimestamp: 1000,
    currentAgentState: 'working',
    currentAgentEntry: null,
    unread: false,
    responsePreview: '',
    ...overrides
  }
}

describe('isChildAgentEntry', () => {
  it('returns false for null, undefined, or entries without orchestration', () => {
    expect(isChildAgentEntry(null)).toBe(false)
    expect(isChildAgentEntry(undefined)).toBe(false)
    expect(isChildAgentEntry(makeTestEntry())).toBe(false)
  })

  it('returns true when parentPaneKey is different from entry paneKey', () => {
    const entry = makeTestEntry({
      orchestration: {
        parentPaneKey: PANE_KEY_2,
        taskId: 'task-1',
        dispatchId: 'ctx-1'
      }
    })
    expect(isChildAgentEntry(entry)).toBe(true)
  })

  it('returns false when parentPaneKey matches entry paneKey', () => {
    const entry = makeTestEntry({
      orchestration: {
        parentPaneKey: PANE_KEY,
        taskId: 'task-1',
        dispatchId: 'ctx-1'
      }
    })
    expect(isChildAgentEntry(entry)).toBe(false)
  })

  it('returns true when parentTerminalHandle is different from entry terminalHandle', () => {
    const entry = makeTestEntry({
      terminalHandle: 'terminal-child',
      orchestration: {
        parentTerminalHandle: 'terminal-parent',
        taskId: 'task-1',
        dispatchId: 'ctx-1'
      }
    })
    expect(isChildAgentEntry(entry)).toBe(true)
  })

  it('returns true when coordinatorHandle is different from entry terminalHandle', () => {
    const entry = makeTestEntry({
      terminalHandle: 'terminal-child',
      orchestration: {
        coordinatorHandle: 'terminal-coordinator',
        taskId: 'task-1',
        dispatchId: 'ctx-1'
      }
    })
    expect(isChildAgentEntry(entry)).toBe(true)
  })

  it('returns false when coordinator terminal handle matches coordinatorHandle', () => {
    const entry = makeTestEntry({
      terminalHandle: 'terminal-coordinator',
      orchestration: {
        coordinatorHandle: 'terminal-coordinator',
        taskId: 'task-1',
        dispatchId: 'ctx-1'
      }
    })
    expect(isChildAgentEntry(entry)).toBe(false)
  })
})

describe('isChildAgentThread', () => {
  it('returns false for standalone threads', () => {
    const thread = makeTestThread({
      currentAgentEntry: makeTestEntry({ prompt: 'standalone task' })
    })
    expect(isChildAgentThread(thread)).toBe(false)
  })

  it('returns true when currentAgentEntry is a child agent', () => {
    const thread = makeTestThread({
      currentAgentEntry: makeTestEntry({
        orchestration: {
          parentPaneKey: PANE_KEY_2,
          taskId: 'task-1',
          dispatchId: 'ctx-1'
        }
      })
    })
    expect(isChildAgentThread(thread)).toBe(true)
  })

  it('returns true when latestEvent entry is a child agent', () => {
    const worktree = makeWorktree()
    const tab = makeTabWithIds('tab-1', worktree.id)
    const childEntry = makeTestEntry({
      terminalHandle: 'terminal-child',
      orchestration: {
        coordinatorHandle: 'terminal-coord',
        taskId: 'task-1',
        dispatchId: 'ctx-1'
      }
    })
    const event: ActivityEvent = {
      id: 'event-1',
      state: 'done',
      timestamp: 1000,
      unread: false,
      worktree,
      repo: null,
      tab,
      agentType: 'claude',
      agentAlive: true,
      entry: childEntry
    }
    const thread = makeTestThread({
      currentAgentEntry: null,
      latestEvent: event,
      events: [event]
    })
    expect(isChildAgentThread(thread)).toBe(true)
  })

  it('returns true when any event in events is a child agent', () => {
    const worktree = makeWorktree()
    const tab = makeTabWithIds('tab-1', worktree.id)
    const childEntry = makeTestEntry({
      orchestration: {
        parentPaneKey: PANE_KEY_2,
        taskId: 'task-1',
        dispatchId: 'ctx-1'
      }
    })
    const event: ActivityEvent = {
      id: 'event-1',
      state: 'done',
      timestamp: 1000,
      unread: false,
      worktree,
      repo: null,
      tab,
      agentType: 'claude',
      agentAlive: true,
      entry: childEntry
    }
    const thread = makeTestThread({
      currentAgentEntry: null,
      latestEvent: null,
      events: [event]
    })
    expect(isChildAgentThread(thread)).toBe(true)
  })
})
