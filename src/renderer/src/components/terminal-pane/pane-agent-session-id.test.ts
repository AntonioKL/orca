import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { resolvePaneAgentSessionId, type PaneAgentSessionIdState } from './pane-agent-session-id'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function state(
  live?: AgentStatusEntry,
  sleeping?: SleepingAgentSessionRecord
): PaneAgentSessionIdState {
  return {
    agentStatusByPaneKey: live ? { [PANE_KEY]: live } : {},
    sleepingAgentSessionsByPaneKey: sleeping ? { [PANE_KEY]: sleeping } : {}
  }
}

function live(sessionId?: string, restoredUnconfirmed = false): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: 2,
    stateStartedAt: 2,
    paneKey: PANE_KEY,
    agentType: 'claude',
    stateHistory: [],
    ...(sessionId ? { providerSession: { key: 'session_id', id: sessionId } } : {}),
    ...(restoredUnconfirmed ? { restoredUnconfirmed: true } : {})
  }
}

function sleeping(sessionId: string): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'worktree-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: sessionId },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live'
  }
}

describe('resolvePaneAgentSessionId', () => {
  it('returns the live provider session for the exact pane', () => {
    expect(resolvePaneAgentSessionId(state(live('live-session')), PANE_KEY)).toBe('live-session')
  })

  it('returns the pane-owned durable session after its live status row is cleared', () => {
    expect(
      resolvePaneAgentSessionId(state(undefined, sleeping('sleeping-session')), PANE_KEY)
    ).toBe('sleeping-session')
  })

  it('does not reuse an older durable session while a newer live row lacks identity', () => {
    expect(resolvePaneAgentSessionId(state(live(), sleeping('old-session')), PANE_KEY)).toBeNull()
  })

  it('falls back from an unconfirmed restored row to durable pane identity', () => {
    expect(
      resolvePaneAgentSessionId(
        state(live('unconfirmed-session', true), sleeping('confirmed-session')),
        PANE_KEY
      )
    ).toBe('confirmed-session')
  })

  it('does not read identity from a sibling pane', () => {
    const sibling = 'tab-1:22222222-2222-4222-8222-222222222222'
    expect(resolvePaneAgentSessionId(state(undefined, sleeping('session-1')), sibling)).toBeNull()
  })
})
