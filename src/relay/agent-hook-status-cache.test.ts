import { describe, expect, it, vi } from 'vitest'

import { createHookListenerState, type AgentHookEventPayload } from '../shared/agent-hook-listener'
import { applyRelayHookEvent } from './agent-hook-status-cache'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function event(
  hookEventName: string,
  reconcileDiagnostic?: AgentHookEventPayload['reconcileDiagnostic']
): AgentHookEventPayload {
  return {
    paneKey: PANE_KEY,
    source: 'codex',
    connectionId: null,
    hookEventName,
    ...(reconcileDiagnostic !== undefined ? { reconcileDiagnostic } : {}),
    payload: { state: 'working', prompt: 'prompt', agentType: 'codex' }
  }
}

describe('relay agent-hook status cache', () => {
  it('clears an inherited Codex reconciliation diagnostic at SessionStart', () => {
    const state = createHookListenerState()
    const metadata = new Map<string, { source: 'codex' }>()
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const options = {
      state,
      previous: undefined,
      source: 'codex' as const,
      metadata,
      persist: vi.fn(),
      clearPaneState: vi.fn(),
      forward
    }

    applyRelayHookEvent({
      ...options,
      event: event('PostToolUse', {
        kind: 'unverifiable',
        reason: 'transcript-unreadable',
        observedAt: 100
      })
    })
    const previous = state.lastStatusByPaneKey.get(PANE_KEY)
    expect(previous?.reconcileDiagnostic).toBeDefined()

    applyRelayHookEvent({
      ...options,
      previous,
      event: event('SessionStart')
    })

    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.reconcileDiagnostic).toBeNull()
    expect(forward.mock.calls.at(-1)?.[0].reconcileDiagnostic).toBeNull()
  })
})
