import type { AgentSessionHandleProvider } from './agent-session-provider-handle'

export function agentSessionProviderLabel(provider: AgentSessionHandleProvider): string {
  return provider === 'claude' ? 'Claude' : 'Codex'
}

export function agentSessionChatLabel(provider: AgentSessionHandleProvider): string {
  return `${agentSessionProviderLabel(provider)} Chat`
}
