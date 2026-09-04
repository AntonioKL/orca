import { OrcaRuntimeWithSerializeAgentPromptSubmission } from './orca-runtime-serialize-agent-prompt-submission'
import type { RuntimeTerminalPromptDelivery } from '../../shared/runtime-types'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { TerminalHandleRecord } from './runtime-terminal-contracts'
import type {
  AgentPromptTurnStartEvidence,
  AgentPromptWaitTextCache
} from './agent-prompt-submission-verification'
import { verifyAgentPromptSubmission } from './agent-prompt-submission-verification'

const AGENT_PROMPT_CORRELATION_LIMIT_PER_PTY = 1_024

type AgentPromptRequestBaseline = {
  ptyId: string
  generation: number
  requestId: string
  baselineWorkingSequence: number
  baselineExplicitWorkingStartedAt: number | null
}

export class OrcaRuntimeWithAgentPromptRequestCorrelation extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  // Turn evidence is PTY-wide; keep a request owner so one observed turn
  // cannot settle every queued prompt that shares the same baseline.
  private agentPromptRequestBaselines = new Map<string, AgentPromptRequestBaseline>()
  private agentPromptTurnStartClaims = new Map<string, string>()
  // Declared, not defined: both live further up the mixin chain, so this link cannot see them.
  declare protected getLivePtyForHandle: (
    handle: string
  ) => { record: TerminalHandleRecord; pty: RuntimePtyWorktreeRecord } | null
  declare protected getLiveLeafForHandle: (handle: string) => {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  }

  getTerminalPromptRequestBinding(handle: string): {
    ptyId: string
    processIncarnation: string
    generation: number
  } {
    const live = this.getLivePtyForHandle(handle)
    const ptyId = live?.pty.ptyId ?? this.getLiveLeafForHandle(handle).leaf.ptyId
    if (!ptyId) {
      throw new Error('terminal_not_writable')
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const incarnationId = live?.pty.incarnationId ?? this.ptysById.get(ptyId)?.incarnationId
    return {
      ptyId,
      processIncarnation: incarnationId ?? `${this.runtimeId}:${ptyId}:${generation}`,
      generation
    }
  }

  async observeTerminalAgentPrompt(
    handle: string,
    prompt: RuntimeTerminalPromptDelivery,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<RuntimeTerminalPromptDelivery> {
    const binding = this.getTerminalPromptRequestBinding(handle)
    if (
      binding.processIncarnation !== prompt.processIncarnation ||
      binding.generation !== prompt.generation
    ) {
      return { ...prompt, observation: 'incarnation_replaced' }
    }
    const waitTextCache: AgentPromptWaitTextCache = {}
    const baseline = this.getAgentPromptActivity(handle, binding.ptyId, waitTextCache)
    try {
      await verifyAgentPromptSubmission({
        baseline: {
          ...baseline,
          workingSequence: prompt.baselineWorkingSequence,
          ...(prompt.baselinePermissionSequence !== undefined
            ? { permissionSequence: prompt.baselinePermissionSequence }
            : {}),
          ...(prompt.baselineExplicitWorkingStartedAt !== undefined
            ? { explicitWorkingStartedAt: prompt.baselineExplicitWorkingStartedAt }
            : {})
        },
        readActivity: () => this.getAgentPromptActivity(handle, binding.ptyId, waitTextCache),
        acceptTurnStart: (evidence) =>
          this.acceptAgentPromptTurnStart(
            binding.ptyId,
            binding.generation,
            prompt.requestId,
            prompt.baselineWorkingSequence,
            prompt.baselineExplicitWorkingStartedAt ?? null,
            evidence
          ),
        // Old hosts omit the hook baseline, so their receipts retain title-only observation.
        allowHookEvidence: prompt.baselineExplicitWorkingStartedAt !== undefined,
        allowOutputEvidence: false,
        signal,
        timeoutMs
      })
      this.forgetAgentPromptRequest(binding.ptyId, binding.generation, prompt.requestId)
      return {
        ...prompt,
        stages: ['input_accepted', 'submission_observed', 'turn_started'],
        observation: 'supported'
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'agent_prompt_stalled') {
        return prompt
      }
      if (error instanceof Error && error.message === 'agent_prompt_blocked') {
        this.forgetAgentPromptRequest(binding.ptyId, binding.generation, prompt.requestId)
        return { ...prompt, observation: 'permission' }
      }
      throw error
    }
  }

  protected registerAgentPromptRequest(
    ptyId: string,
    generation: number,
    requestId: string,
    baselineWorkingSequence: number,
    baselineExplicitWorkingStartedAt: number | null
  ): void {
    const requestKey = this.agentPromptRequestKey(ptyId, generation, requestId)
    this.agentPromptRequestBaselines.delete(requestKey)
    this.agentPromptRequestBaselines.set(requestKey, {
      ptyId,
      generation,
      requestId,
      baselineWorkingSequence,
      baselineExplicitWorkingStartedAt
    })
    const prefix = `${ptyId}\u0000${generation}\u0000`
    const matchingKeys = [...this.agentPromptRequestBaselines.keys()].filter((key) =>
      key.startsWith(prefix)
    )
    for (const staleKey of matchingKeys.slice(0, -AGENT_PROMPT_CORRELATION_LIMIT_PER_PTY)) {
      this.agentPromptRequestBaselines.delete(staleKey)
    }
  }

  protected forgetAgentPromptRequest(ptyId: string, generation: number, requestId: string): void {
    this.agentPromptRequestBaselines.delete(
      this.agentPromptRequestKey(ptyId, generation, requestId)
    )
  }

  protected acceptAgentPromptTurnStart(
    ptyId: string,
    generation: number,
    requestId: string,
    baselineWorkingSequence: number,
    baselineExplicitWorkingStartedAt: number | null,
    evidence: AgentPromptTurnStartEvidence
  ): boolean {
    if (
      !this.isAgentPromptTurnStartAfterBaseline(evidence, {
        baselineWorkingSequence,
        baselineExplicitWorkingStartedAt
      })
    ) {
      return false
    }
    // A receipt restored after a runtime restart has no in-memory registration;
    // leave it queued rather than attributing an unrelated turn to it.
    const requestKey = this.agentPromptRequestKey(ptyId, generation, requestId)
    const request = this.agentPromptRequestBaselines.get(requestKey)
    if (
      !request ||
      request.ptyId !== ptyId ||
      request.generation !== generation ||
      request.baselineWorkingSequence !== baselineWorkingSequence ||
      request.baselineExplicitWorkingStartedAt !== baselineExplicitWorkingStartedAt
    ) {
      return false
    }
    let claimKey: string | null
    if (evidence.kind === 'lifecycle') {
      this.allocateAgentPromptLifecycleClaims(ptyId, generation, evidence)
      claimKey = this.findAgentPromptTurnClaimKey(ptyId, generation, requestId)
    } else {
      for (const [candidateKey, candidate] of this.agentPromptRequestBaselines) {
        if (
          candidate.ptyId === ptyId &&
          candidate.generation === generation &&
          this.isAgentPromptTurnStartAfterBaseline(evidence, candidate)
        ) {
          if (candidateKey !== requestKey) {
            return false
          }
          break
        }
      }
      claimKey = this.getAgentPromptTurnClaimKey(
        ptyId,
        generation,
        baselineWorkingSequence,
        evidence
      )
    }
    if (!claimKey) {
      return false
    }
    const owner = this.agentPromptTurnStartClaims.get(claimKey)
    if (owner && owner !== requestId) {
      return false
    }
    this.agentPromptTurnStartClaims.set(claimKey, requestId)
    this.agentPromptRequestBaselines.delete(requestKey)
    const claimPrefix = `${ptyId}\u0000${generation}\u0000`
    const matchingClaimKeys = [...this.agentPromptTurnStartClaims.keys()].filter((key) =>
      key.startsWith(claimPrefix)
    )
    for (const staleKey of matchingClaimKeys.slice(0, -AGENT_PROMPT_CORRELATION_LIMIT_PER_PTY)) {
      this.agentPromptTurnStartClaims.delete(staleKey)
    }
    return true
  }

  private allocateAgentPromptLifecycleClaims(
    ptyId: string,
    generation: number,
    evidence: Extract<AgentPromptTurnStartEvidence, { kind: 'lifecycle' }>
  ): void {
    for (const candidate of this.agentPromptRequestBaselines.values()) {
      if (
        candidate.ptyId !== ptyId ||
        candidate.generation !== generation ||
        !this.isAgentPromptTurnStartAfterBaseline(evidence, candidate)
      ) {
        continue
      }
      if (this.findAgentPromptTurnClaimKey(ptyId, generation, candidate.requestId)) {
        continue
      }
      const claimKey = this.getAgentPromptTurnClaimKey(
        ptyId,
        generation,
        candidate.baselineWorkingSequence,
        evidence
      )
      if (!claimKey) {
        return
      }
      this.agentPromptTurnStartClaims.set(claimKey, candidate.requestId)
    }
  }

  private findAgentPromptTurnClaimKey(
    ptyId: string,
    generation: number,
    requestId: string
  ): string | null {
    const prefix = `${ptyId}\u0000${generation}\u0000`
    for (const [claimKey, owner] of this.agentPromptTurnStartClaims) {
      if (claimKey.startsWith(prefix) && owner === requestId) {
        return claimKey
      }
    }
    return null
  }

  private isAgentPromptTurnStartAfterBaseline(
    evidence: AgentPromptTurnStartEvidence,
    baseline: {
      baselineWorkingSequence: number
      baselineExplicitWorkingStartedAt: number | null
    }
  ): boolean {
    return evidence.kind === 'lifecycle'
      ? evidence.workingSequence > baseline.baselineWorkingSequence
      : evidence.workingStartedAt > (baseline.baselineExplicitWorkingStartedAt ?? 0)
  }

  private getAgentPromptTurnClaimKey(
    ptyId: string,
    generation: number,
    baselineWorkingSequence: number,
    evidence: AgentPromptTurnStartEvidence
  ): string | null {
    const prefix = `${ptyId}\u0000${generation}\u0000`
    if (evidence.kind === 'hook') {
      return `${prefix}hook:${evidence.workingStartedAt}`
    }
    const lifecyclePrefix = `${prefix}lifecycle:`
    const claimedSequences = new Set<number>()
    for (const key of this.agentPromptTurnStartClaims.keys()) {
      if (!key.startsWith(lifecyclePrefix)) {
        continue
      }
      const sequence = Number(key.slice(lifecyclePrefix.length))
      if (Number.isFinite(sequence)) {
        claimedSequences.add(sequence)
      }
    }
    let sequence = baselineWorkingSequence + 1
    while (claimedSequences.has(sequence)) {
      sequence += 1
    }
    return sequence <= evidence.workingSequence ? `${lifecyclePrefix}${sequence}` : null
  }

  private agentPromptRequestKey(ptyId: string, generation: number, requestId: string): string {
    return `${ptyId}\u0000${generation}\u0000${requestId}`
  }

  protected clearAgentPromptCorrelationForPty(ptyId: string): void {
    for (const key of this.agentPromptRequestBaselines.keys()) {
      if (key.startsWith(`${ptyId}\u0000`)) {
        this.agentPromptRequestBaselines.delete(key)
      }
    }
    for (const key of this.agentPromptTurnStartClaims.keys()) {
      if (key.startsWith(`${ptyId}\u0000`)) {
        this.agentPromptTurnStartClaims.delete(key)
      }
    }
  }
}
