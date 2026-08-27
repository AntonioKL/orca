import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'

export type RelayHookForward = (envelope: AgentHookRelayEnvelope) => void
export type RelayHookServerOptions = {
  endpointDir?: string
  env?: string
  token?: string
  preferredPort?: number
  forward: RelayHookForward
}
export type RelayHookServerStartOptions = { publishEndpoint?: boolean }
