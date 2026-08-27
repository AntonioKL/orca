import { describe, expect, it, vi } from 'vitest'

import { createHookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { applyRelayEvent } from './agent-hook-event-application'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function apply(isReplay: boolean): {
  live: ReturnType<typeof vi.fn>
  restart: ReturnType<typeof vi.fn>
} {
  const scheduleCodexReconciliation = vi.fn()
  const scheduleCodexRestartReconciliation = vi.fn()
  const event: AgentHookEventPayload = {
    paneKey: PANE_KEY,
    source: 'codex',
    connectionId: null,
    hookEventName: 'UserPromptSubmit',
    payload: { state: 'working', prompt: 'new turn', agentType: 'codex' }
  }
  applyRelayEvent({
    state: createHookListenerState(),
    event,
    source: 'codex',
    isReplay,
    metadata: new Map(),
    persist: vi.fn(),
    clearPaneState: vi.fn(),
    forward: vi.fn(),
    scheduleCodexReconciliation,
    scheduleCodexRestartReconciliation,
    clearAssistantMessageRetry: vi.fn()
  })
  return { live: scheduleCodexReconciliation, restart: scheduleCodexRestartReconciliation }
}

describe('relay hook event application', () => {
  it('uses live reconciliation for live events', () => {
    const scheduled = apply(false)
    expect(scheduled.live).toHaveBeenCalledWith(PANE_KEY)
    expect(scheduled.restart).not.toHaveBeenCalled()
  })

  it('preserves replay provenance for spool replay reconciliation', () => {
    const scheduled = apply(true)
    expect(scheduled.restart).toHaveBeenCalledWith(PANE_KEY)
    expect(scheduled.live).not.toHaveBeenCalled()
  })
})
