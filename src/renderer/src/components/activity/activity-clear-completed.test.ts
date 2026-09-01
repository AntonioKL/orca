import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { ActivityEvent, AgentPaneThread } from './activity-thread-types'
import { makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

const mockStore = vi.hoisted(() => {
  const state = {
    activityClearedAtByPaneKey: {} as Record<string, number>,
    retainedAgentsByPaneKey: {} as Record<string, RetainedAgentEntry>,
    applyActivityClearedAt: vi.fn((patch: Record<string, number | null>) => {
      const next = { ...state.activityClearedAtByPaneKey }
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
          delete next[key]
        } else {
          next[key] = value
        }
      }
      state.activityClearedAtByPaneKey = next
    }),
    dismissRetainedAgents: vi.fn((paneKeys: readonly string[]) => {
      const next = { ...state.retainedAgentsByPaneKey }
      for (const key of paneKeys) {
        delete next[key]
      }
      state.retainedAgentsByPaneKey = next
    }),
    retainAgents: vi.fn((entries: RetainedAgentEntry[]) => {
      const next = { ...state.retainedAgentsByPaneKey }
      for (const retained of entries) {
        next[retained.entry.paneKey] = retained
      }
      state.retainedAgentsByPaneKey = next
    })
  }
  return state
})

const toastSpy = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStore }
}))
vi.mock('sonner', () => ({ toast: toastSpy }))

import {
  clearCompletedActivity,
  isClearableActivityThread,
  planClearCompletedActivity
} from './activity-clear-completed'

function makeThread(paneKey: string, overrides: Partial<AgentPaneThread> = {}): AgentPaneThread {
  return {
    paneKey,
    tab: makeTab(),
    worktree: makeWorktree(),
    repo: null,
    currentAgentState: null,
    currentAgentEntry: null,
    latestEvent: null,
    latestTimestamp: 5_000,
    agentType: 'claude',
    unread: false,
    paneTitle: `Agent ${paneKey}`,
    responsePreview: '',
    events: [],
    ...overrides
  }
}

function doneEvent(interrupted: boolean): ActivityEvent {
  return {
    id: 'evt',
    state: 'done',
    timestamp: 5_000,
    worktree: makeWorktree(),
    repo: null,
    entry: { interrupted } as ActivityEvent['entry'],
    tab: makeTab(),
    agentType: 'claude',
    agentAlive: false,
    unread: false
  }
}

const workingThread = makeThread('t-working:1', { currentAgentState: 'working' })
const blockedThread = makeThread('t-blocked:1', { currentAgentState: 'blocked' })
const waitingThread = makeThread('t-waiting:1', { currentAgentState: 'waiting' })
const doneThread = makeThread('t-done:1', { latestEvent: doneEvent(false) })
const interruptedThread = makeThread('t-interrupted:1', { latestEvent: doneEvent(true) })

function makeRetained(paneKey: string): RetainedAgentEntry {
  return {
    entry: {
      state: 'done',
      prompt: 'retained run',
      updatedAt: 5_000,
      stateStartedAt: 5_000,
      paneKey,
      stateHistory: [],
      agentType: 'claude'
    },
    worktreeId: 'wt-1',
    tab: makeTab(),
    agentType: 'claude',
    startedAt: 5_000
  }
}

describe('isClearableActivityThread', () => {
  it('clears only completed and interrupted threads', () => {
    expect(isClearableActivityThread(doneThread)).toBe(true)
    expect(isClearableActivityThread(interruptedThread)).toBe(true)
    expect(isClearableActivityThread(workingThread)).toBe(false)
    expect(isClearableActivityThread(blockedThread)).toBe(false)
    expect(isClearableActivityThread(waitingThread)).toBe(false)
  })
})

describe('clearCompletedActivity', () => {
  beforeEach(() => {
    mockStore.activityClearedAtByPaneKey = {}
    mockStore.retainedAgentsByPaneKey = { 't-done:1': makeRetained('t-done:1') }
    vi.stubGlobal('window', { api: { agentStatus: { drop: vi.fn() } } })
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  function lastToastOptions(): {
    action: { label: string; onClick: () => void }
    onDismiss: () => void
    onAutoClose: () => void
  } {
    return toastSpy.mock.calls.at(-1)?.[1]
  }

  it('plans cutoffs and retained removals for completed threads only', () => {
    const plan = planClearCompletedActivity(
      [workingThread, blockedThread, doneThread, interruptedThread],
      mockStore
    )
    expect(plan.clearedThreadCount).toBe(2)
    expect(plan.cutoffPatch).toEqual({ 't-done:1': 5_000, 't-interrupted:1': 5_000 })
    expect(plan.restorePatch).toEqual({ 't-done:1': null, 't-interrupted:1': null })
    expect(plan.retainedSnapshots.map((r) => r.entry.paneKey)).toEqual(['t-done:1'])
  })

  it('stamps cutoffs, dismisses retained snapshots, and defers the disk drop to toast close', () => {
    const cleared = clearCompletedActivity([workingThread, doneThread, interruptedThread])
    expect(cleared).toBe(true)
    expect(mockStore.activityClearedAtByPaneKey).toEqual({
      't-done:1': 5_000,
      't-interrupted:1': 5_000
    })
    expect(mockStore.dismissRetainedAgents).toHaveBeenCalledWith(['t-done:1'])
    const drop = (window as unknown as { api: { agentStatus: { drop: ReturnType<typeof vi.fn> } } })
      .api.agentStatus.drop
    expect(drop).not.toHaveBeenCalled()

    lastToastOptions().onAutoClose()
    expect(drop).toHaveBeenCalledTimes(1)
    expect(drop).toHaveBeenCalledWith('t-done:1')
    // A later dismiss must not double-drop.
    lastToastOptions().onDismiss()
    expect(drop).toHaveBeenCalledTimes(1)
  })

  it('undo restores prior cutoffs and re-retains snapshots, and skips the disk drop', () => {
    mockStore.activityClearedAtByPaneKey = { 't-done:1': 1_111 }
    clearCompletedActivity([doneThread, interruptedThread])
    expect(mockStore.activityClearedAtByPaneKey).toEqual({
      't-done:1': 5_000,
      't-interrupted:1': 5_000
    })
    expect(mockStore.retainedAgentsByPaneKey['t-done:1']).toBeUndefined()

    lastToastOptions().action.onClick()
    expect(mockStore.activityClearedAtByPaneKey).toEqual({ 't-done:1': 1_111 })
    expect(mockStore.retainedAgentsByPaneKey['t-done:1']).toBeDefined()

    lastToastOptions().onAutoClose()
    const drop = (window as unknown as { api: { agentStatus: { drop: ReturnType<typeof vi.fn> } } })
      .api.agentStatus.drop
    expect(drop).not.toHaveBeenCalled()
  })

  it('does nothing when no thread is clearable', () => {
    expect(clearCompletedActivity([workingThread, blockedThread])).toBe(false)
    expect(toastSpy).not.toHaveBeenCalled()
    expect(mockStore.applyActivityClearedAt).not.toHaveBeenCalled()
  })
})
