import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { countActivityUnread } from './useActivityUnreadCount'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function makeEntry(overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: 2_000,
    stateStartedAt: 2_000,
    paneKey: PANE,
    agentType: 'claude',
    stateHistory: [],
    ...overrides
  }
}

function makeSource(entry: AgentStatusEntry, ackAt = 0) {
  return {
    acknowledgedAgentsByPaneKey: { [PANE]: ackAt },
    agentStatusByPaneKey: { [PANE]: entry },
    migrationUnsupportedByPtyId: {},
    retainedAgentsByPaneKey: {}
  }
}

describe('countActivityUnread session-boundary rows (STA-3386)', () => {
  it('does not count a session-boundary done as unread in either mode', () => {
    const source = makeSource(makeEntry({ sessionBoundary: true }))
    expect(countActivityUnread(source, 'sidebar-badge')).toBe(0)
    expect(countActivityUnread(source, 'agent-events')).toBe(0)
  })

  it('keeps counting a real completion displaced into history by a session boundary', () => {
    // Why: agent finished (unacknowledged), then the user resumed the session — the
    // boundary row replaces the live done but the finish must stay unread in both badges.
    const source = makeSource(
      makeEntry({
        sessionBoundary: true,
        stateHistory: [{ state: 'done', prompt: 'fix bug', startedAt: 1_000 }]
      })
    )
    expect(countActivityUnread(source, 'sidebar-badge')).toBe(1)
    expect(countActivityUnread(source, 'agent-events')).toBe(1)
  })

  it('stops counting the displaced completion once acknowledged', () => {
    const source = makeSource(
      makeEntry({
        sessionBoundary: true,
        stateHistory: [{ state: 'done', prompt: 'fix bug', startedAt: 1_000 }]
      }),
      1_500
    )
    expect(countActivityUnread(source, 'sidebar-badge')).toBe(0)
    expect(countActivityUnread(source, 'agent-events')).toBe(0)
  })

  it('still counts an ordinary unacknowledged done in sidebar-badge mode', () => {
    const source = makeSource(makeEntry({}))
    expect(countActivityUnread(source, 'sidebar-badge')).toBe(1)
  })
})

describe('countActivityUnread child-agent filtering (sidebar-badge)', () => {
  const PARENT_PANE = 'tab-2:22222222-2222-4222-8222-222222222222'

  function makeChildSource(parentPaneKey: string) {
    const parent = makeEntry({ state: 'working', paneKey: PARENT_PANE })
    const child = makeEntry({
      orchestration: { taskId: 'task-1', dispatchId: 'dispatch-1', parentPaneKey }
    })
    return {
      acknowledgedAgentsByPaneKey: {},
      agentStatusByPaneKey: { [PARENT_PANE]: parent, [PANE]: child },
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {}
    }
  }

  it('excludes a child of a listed parent so the badge matches what Mark all read clears', () => {
    const source = makeChildSource(PARENT_PANE)
    expect(countActivityUnread(source, 'sidebar-badge')).toBe(0)
    // The full-page event badge keeps counting every event.
    expect(countActivityUnread(source, 'agent-events')).toBe(1)
  })

  it('counts the child when child agents are shown', () => {
    const source = { ...makeChildSource(PARENT_PANE), showChildAgents: true }
    expect(countActivityUnread(source, 'sidebar-badge')).toBe(1)
  })

  it('counts an orphaned child whose parent pane is gone (promoted to top level)', () => {
    const source = makeChildSource('tab-9:99999999-9999-4999-8999-999999999999')
    expect(countActivityUnread(source, 'sidebar-badge')).toBe(1)
  })
})

describe('countActivityUnread with Clear completed cutoffs', () => {
  it('does not count events hidden by the pane cutoff', () => {
    const source = {
      ...makeSource(
        makeEntry({
          stateHistory: [{ state: 'done', prompt: 'older run', startedAt: 1_000 }]
        })
      ),
      activityClearedAtByPaneKey: { [PANE]: 2_000 }
    }
    // Both the history event (1_000) and the live done (2_000) are at or before the cutoff.
    expect(countActivityUnread(source, 'agent-events')).toBe(0)
    expect(countActivityUnread(source, 'sidebar-badge')).toBe(0)
  })

  it('keeps counting turns newer than the cutoff', () => {
    const source = {
      ...makeSource(
        makeEntry({
          stateStartedAt: 3_000,
          stateHistory: [{ state: 'done', prompt: 'older run', startedAt: 1_000 }]
        })
      ),
      activityClearedAtByPaneKey: { [PANE]: 2_000 }
    }
    expect(countActivityUnread(source, 'agent-events')).toBe(1)
    expect(countActivityUnread(source, 'sidebar-badge')).toBe(1)
  })
})
