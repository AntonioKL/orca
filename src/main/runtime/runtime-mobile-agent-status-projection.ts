import {
  AGENT_STATUS_STALE_AFTER_MS,
  pickParsedAgentStatusPayload,
  type AgentStatusEntry,
  type AgentStatusIpcPayload
} from '../../shared/agent-status-types'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import { terminalTitleBlocksExplicitAgentStatus } from './runtime-worktree-status-projection'
import type { HookLiveAgentRow } from './runtime-terminal-contracts'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

export function renewRuntimeMobileAgentStatusFromPtyTitle(
  status: AgentStatusEntry | null,
  pty: RuntimePtyWorktreeRecord | null,
  options: { preserveQuestionUnderShellTitle?: boolean } = {}
): AgentStatusEntry | null {
  if (!status || !pty) {
    return status
  }
  if (
    options.preserveQuestionUnderShellTitle &&
    status.interactivePrompt != null &&
    terminalTitleBlocksExplicitAgentStatus(pty.lastOscTitle)
  ) {
    return status
  }
  const richStatusCanOwnTitleInterval =
    pty.lastAgentStatusRichInvalidatedAtEpochMs === null ||
    status.updatedAt > pty.lastAgentStatusRichInvalidatedAtEpochMs
  const titleEvidenceAt = pty.lastOscTitleEpochMs
  if (titleEvidenceAt === null) {
    return richStatusCanOwnTitleInterval ? status : null
  }
  const buildTitleOnlyStatus = (
    state: AgentStatusEntry['state'],
    updatedAt: number,
    stateStartedAt: number
  ): AgentStatusEntry => ({
    state,
    prompt: '',
    updatedAt,
    stateStartedAt,
    paneKey: status.paneKey,
    stateHistory: [],
    ...(status.agentType ? { agentType: status.agentType } : {}),
    ...(status.terminalHandle ? { terminalHandle: status.terminalHandle } : {}),
    ...(status.worktreeId ? { worktreeId: status.worktreeId } : {}),
    ...(status.tabId ? { tabId: status.tabId } : {}),
    ...(status.terminalTitle ? { terminalTitle: status.terminalTitle } : {}),
    ...(status.providerSession ? { providerSession: status.providerSession } : {})
  })
  const titleConfirmsState =
    (pty.lastAgentStatus === 'working' && status.state === 'working') ||
    (pty.lastAgentStatus === 'permission' &&
      (status.state === 'blocked' || status.state === 'waiting'))
  if (!titleConfirmsState) {
    if (richStatusCanOwnTitleInterval && status.updatedAt >= titleEvidenceAt) {
      return status
    }
    if (pty.lastAgentStatus === null && !terminalTitleBlocksExplicitAgentStatus(pty.lastOscTitle)) {
      return status
    }
    const titleState =
      pty.lastAgentStatus === 'working'
        ? 'working'
        : pty.lastAgentStatus === 'permission'
          ? 'blocked'
          : 'done'
    return buildTitleOnlyStatus(
      titleState,
      titleEvidenceAt,
      pty.lastAgentStatusStartedAtEpochMs ?? titleEvidenceAt
    )
  }
  const richStatusOwnsCurrentState =
    Date.now() - status.updatedAt <= AGENT_STATUS_STALE_AFTER_MS && richStatusCanOwnTitleInterval
  const stateStartedAt = richStatusOwnsCurrentState
    ? status.stateStartedAt
    : (pty.lastAgentStatusStartedAtEpochMs ?? status.stateStartedAt)
  if (richStatusOwnsCurrentState) {
    pty.lastAgentStatusStartedAtEpochMs = stateStartedAt
  }
  const updatedAt = Math.max(status.updatedAt, titleEvidenceAt)
  if (!richStatusOwnsCurrentState) {
    return buildTitleOnlyStatus(status.state, updatedAt, stateStartedAt)
  }
  return updatedAt === status.updatedAt && stateStartedAt === status.stateStartedAt
    ? status
    : { ...status, updatedAt, stateStartedAt }
}

export type RuntimeHookAgentRowLookup = {
  providerSession: AgentProviderSessionMetadata | null
  providerSessionAgentType: string | null
  providerSessionReceivedAt: number | null
  agentType: string | null
  live: HookLiveAgentRow | null
}

export function selectRuntimeHookAgentRowForPane(
  rows: readonly AgentStatusIpcPayload[]
): RuntimeHookAgentRowLookup {
  let session: AgentStatusIpcPayload | null = null
  let agent: AgentStatusIpcPayload | null = null
  let live: AgentStatusIpcPayload | null = null
  const freshAfter = Date.now() - AGENT_STATUS_STALE_AFTER_MS
  for (const entry of rows) {
    if (entry.providerSession && (!session || entry.receivedAt > session.receivedAt)) {
      session = entry
    }
    if (
      entry.agentType &&
      (entry.providerSessionOnly !== true ||
        (entry.agentType === 'pi' && entry.providerSession != null)) &&
      entry.receivedAt >= freshAfter &&
      (!agent || entry.receivedAt > agent.receivedAt)
    ) {
      agent = entry
    }
    if (
      entry.providerSessionOnly !== true &&
      entry.restoredUnconfirmed !== true &&
      entry.receivedAt >= freshAfter &&
      (!live || entry.receivedAt > live.receivedAt)
    ) {
      live = entry
    }
  }
  return {
    providerSession: session?.providerSession ?? null,
    providerSessionAgentType: session?.agentType ?? null,
    providerSessionReceivedAt: session?.receivedAt ?? null,
    agentType: agent?.agentType ?? null,
    live: live
      ? {
          payload: pickParsedAgentStatusPayload(live),
          updatedAt: live.receivedAt,
          stateStartedAt: live.stateStartedAt ?? live.receivedAt,
          ...(live.worktreeId ? { worktreeId: live.worktreeId } : {})
        }
      : null
  }
}

export function resolveRuntimeHookLiveAgentRow(
  live: HookLiveAgentRow | null,
  pty: RuntimePtyWorktreeRecord | null,
  nonAgentTitle: boolean
): HookLiveAgentRow | null {
  if (!live) {
    return null
  }
  if (live.payload.interactivePrompt != null) {
    return live
  }
  return !nonAgentTitle && live.updatedAt >= (pty?.lastOscTitleEpochMs ?? 0) ? live : null
}
