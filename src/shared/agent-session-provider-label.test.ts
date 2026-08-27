import { describe, expect, it } from 'vitest'
import { agentSessionChatLabel, agentSessionProviderLabel } from './agent-session-provider-label'

describe('agent session provider labels', () => {
  it.each([
    ['claude', 'Claude', 'Claude Chat'],
    ['codex', 'Codex', 'Codex Chat']
  ] as const)('labels %s sessions', (provider, providerLabel, chatLabel) => {
    expect(agentSessionProviderLabel(provider)).toBe(providerLabel)
    expect(agentSessionChatLabel(provider)).toBe(chatLabel)
  })
})
