import { describe, expect, it } from 'vitest'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../shared/structured-agent-session-options'
import { CLAUDE_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-claude-codex'
import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import { setClaudeStructuredOption } from './claude-structured-options'
import type { ClaudeSession } from './claude-structured-session-state'
import { PROVIDER_SESSION_ID, acquired, fakeClaude } from './claude-structured-session-test-support'

const CATALOG = [
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' }
]

function initFrame(model: string): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    session_id: PROVIDER_SESSION_ID,
    uuid: 'turn-init-uuid',
    model,
    apiKeySource: 'none'
  }
}

/** Source the pill reads: 'dispatched' is the one that renders the hedge. */
function modelSource(result: AgentSessionOptionsResult): string | undefined {
  const state = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('claude'),
    CLAUDE_SESSION_OPTION_CATALOG,
    result
  )
  return structuredAgentSessionOptionSnapshot(state).find((d) => d.category === 'model')
    ?.valueSource
}

describe('structured option confirmation reaches the pill', () => {
  it('leaves a just-set model hedged until a turn reports it', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)
    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'haiku', fence: 7 })

    const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(result.current.confirmed ?? []).not.toContain('model')
    expect(modelSource(result)).toBe('dispatched')
  })

  it('clears the hedge once the provider reports the model back', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)
    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'haiku', fence: 7 })
    claude.connections[0]!.handlers.onMessage?.(initFrame('claude-haiku-4-5-20251001'))

    const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(result.current.confirmed).toContain('model')
    expect(modelSource(result)).toBe('reported')
  })

  it('keeps an effort the readback could not take hedged', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      settings: { applied: {}, effective: {}, sources: {} },
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)
    // `max` is session-scoped and absent from the persisted settings, so it records
    // without a readback — recorded, never vouched for.
    await adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'max', fence: 7 })

    const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(result.current.effort).toBe('max')
    expect(result.current.confirmed ?? []).not.toContain('effort')
  })

  it('confirms an effort the readback agreed with', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      settings: { applied: { effort: 'low' }, effective: { effortLevel: 'low' }, sources: {} },
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)
    await adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'low', fence: 7 })

    const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(result.current.confirmed).toContain('effort')
  })

  it('treats a host that reports no confirmation as unconfirmed', () => {
    // Wire compatibility: an older host omits `confirmed` entirely; the client must
    // keep hedging rather than read the absence as a provider report.
    expect(
      modelSource({
        models: [{ id: 'haiku', label: 'Haiku', isDefault: false, efforts: [] }],
        current: { model: 'haiku' }
      })
    ).toBe('dispatched')
  })
})

describe('confirmation never outlives the write it belongs to', () => {
  it('drops an earlier effort confirmation when the value changes', async () => {
    const calls: string[] = []
    let reported = 'low'
    const session = {
      options: new Map<string, string>(),
      optionMutationSequence: 0,
      confirmedOptions: new Set<string>(),
      connection: {
        applyFlagSettings: async (s: { effortLevel?: string }) => {
          calls.push(`apply:${s.effortLevel}`)
        },
        getSettings: async () => ({
          applied: { effort: reported },
          effective: { effortLevel: reported },
          sources: {}
        })
      }
    } as unknown as ClaudeSession

    await setClaudeStructuredOption(session, { key: 'effort', value: 'low' }, undefined)
    expect(session.confirmedOptions.has('effort')).toBe(true)

    // The provider now reports a level it cannot represent; the stale confirmation
    // must not survive into the new value.
    await setClaudeStructuredOption(session, { key: 'effort', value: 'max' }, undefined)
    expect(session.options.get('effort')).toBe('max')
    expect(session.confirmedOptions.has('effort')).toBe(false)
    expect(calls).toEqual(['apply:low', 'apply:max'])
  })
})
