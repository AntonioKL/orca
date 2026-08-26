import { resolveCompatibleAgentTypeForOwner } from './agent-title-owner'
import type { AgentType } from './agent-status-types'
import type {
  PaneAgentEvidence,
  PaneAgentEvidenceSource,
  PaneAgentRunKey
} from './pane-agent-identity-resolver'

export type PaneAgentIdentityFact = {
  agent: AgentType | null | undefined
  run?: PaneAgentRunKey
}

export type PaneAgentProcessIdentityFact = PaneAgentIdentityFact & {
  /** Windows observing wsl.exe is not the execution authority for the distro process. */
  authority?: 'execution-host' | 'wsl-host-proxy'
}

export type PaneAgentRoutingPolicyFacts = {
  routingTrusted?: boolean
  routingRevoked?: boolean
  routingConfirmationPending?: boolean
  shellForeground?: boolean
}

export type CollectPaneAgentIdentityEvidenceInput = {
  /** Trusted launch/startup/accepted-command owner used only for compatibility normalization. */
  compatibilityOwnerAgent?: AgentType | null
  liveHook?: PaneAgentIdentityFact
  process?: PaneAgentProcessIdentityFact
  launch?: PaneAgentIdentityFact
  completedHook?: PaneAgentIdentityFact
  sleepingSession?: PaneAgentIdentityFact
  sibling?: PaneAgentIdentityFact
  title?: PaneAgentIdentityFact
  routingPolicy?: PaneAgentRoutingPolicyFacts
}

export type CollectedPaneAgentIdentityEvidence = {
  evidence: readonly PaneAgentEvidence<AgentType>[]
  routingPolicy: Readonly<PaneAgentRoutingPolicyFacts>
}

const COMPATIBILITY_NORMALIZED_SOURCES: ReadonlySet<PaneAgentEvidenceSource> = new Set([
  'live-hook',
  'process',
  'completed-hook'
])

function appendFact(
  evidence: PaneAgentEvidence<AgentType>[],
  source: PaneAgentEvidenceSource,
  fact: PaneAgentIdentityFact | undefined,
  compatibilityOwnerAgent: AgentType | null | undefined
): void {
  if (!fact?.agent) {
    return
  }
  const agent = COMPATIBILITY_NORMALIZED_SOURCES.has(source)
    ? (resolveCompatibleAgentTypeForOwner(fact.agent, compatibilityOwnerAgent) ?? fact.agent)
    : fact.agent
  evidence.push({ source, agent, ...(fact.run ? { run: fact.run } : {}) })
}

/** Assembles already-collected pane facts without probing or changing a consumer decision. */
export function collectPaneAgentIdentityEvidence(
  input: CollectPaneAgentIdentityEvidenceInput
): CollectedPaneAgentIdentityEvidence {
  const evidence: PaneAgentEvidence<AgentType>[] = []
  appendFact(evidence, 'live-hook', input.liveHook, input.compatibilityOwnerAgent)
  if (input.process?.authority !== 'wsl-host-proxy') {
    appendFact(evidence, 'process', input.process, input.compatibilityOwnerAgent)
  }
  appendFact(evidence, 'launch', input.launch, input.compatibilityOwnerAgent)
  appendFact(evidence, 'completed-hook', input.completedHook, input.compatibilityOwnerAgent)
  appendFact(evidence, 'sleeping-session', input.sleepingSession, input.compatibilityOwnerAgent)
  appendFact(evidence, 'sibling', input.sibling, input.compatibilityOwnerAgent)
  appendFact(evidence, 'title', input.title, input.compatibilityOwnerAgent)
  return { evidence, routingPolicy: { ...input.routingPolicy } }
}
