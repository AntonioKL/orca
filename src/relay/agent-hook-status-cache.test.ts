import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { applyRelayHookEvent, reconcileRelayCodexEvent } from './agent-hook-status-cache'
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
  it('restores working when a newer parent turn follows a historical completion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-hook-status-cache-'))
    try {
      const transcriptPath = join(dir, 'rollout-parent.jsonl')
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`
      )
      const state = createHookListenerState()

      const reconciled = reconcileRelayCodexEvent(state, {
        ...event('PostToolUse'),
        providerSession: { key: 'session_id', id: 'session-1', transcriptPath },
        payload: {
          state: 'done',
          prompt: 'prompt',
          agentType: 'codex',
          subagents: [
            {
              id: '019fa65f-3144-7151-9c02-cff7a28f316f',
              state: 'working',
              startedAt: 1234
            }
          ]
        }
      })

      expect(reconciled.payload.state).toBe('working')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

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
