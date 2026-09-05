import type { OrchestrationMailboxLeaf } from './mailbox-owner'
import type { OrchestrationStatuslessIdleProof } from './mailbox-pointer-state'

export function isStatuslessIdleProofCurrent(
  leaf: OrchestrationMailboxLeaf,
  proof: OrchestrationStatuslessIdleProof,
  getTerminalProcessIncarnation: (terminalHandle: string) => string | null
): boolean {
  if (!isStatuslessIdleProofProcessCurrent(leaf, proof, getTerminalProcessIncarnation)) {
    return false
  }
  return leaf.lastAgentStatusObservedLive
    ? leaf.lastAgentStatus === 'idle'
    : leaf.lastAgentStatus === null
}

export function isStatuslessIdleProofProcessCurrent(
  leaf: OrchestrationMailboxLeaf,
  proof: OrchestrationStatuslessIdleProof,
  getTerminalProcessIncarnation: (terminalHandle: string) => string | null
): boolean {
  return (
    leaf.ptyId === proof.ptyId &&
    getTerminalProcessIncarnation(proof.terminalHandle) === proof.processIncarnation
  )
}
