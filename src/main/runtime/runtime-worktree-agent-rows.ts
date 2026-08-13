import {
  isFreshNonDoneAgentStatus,
  type AgentStatusIpcPayload,
  type ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import type { RuntimeWorktreeAgentRow, RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import { mergeWorktreeStatus } from './runtime-worktree-status-projection'
import type { RuntimeWorktreeSummaryPathIndex } from './runtime-worktree-summary-paths'

export type RuntimeAgentRowSnapshot = {
  paneKey: string
  ptyId: string
  worktreeId?: string
  tabId?: string
  connectionId: string | null
  payload: ParsedAgentStatusPayload
  stateStartedAt: number
  updatedAt: number
}

type ConnectedPtyEvidence = {
  tabIds: ReadonlySet<string>
  paneKeys: ReadonlySet<string>
  ptyIds: ReadonlySet<string>
}

type OrchestrationDisplay = {
  taskTitle?: string | null
  displayName?: string | null
  parentPaneKey?: string | null
}

export function attachRuntimeWorktreeAgentRows(args: {
  summaries: Map<string, RuntimeWorktreePsSummary>
  pathIndex: RuntimeWorktreeSummaryPathIndex
  missingWorktreeIds: Set<string>
  mirroredWorktreeIdByTabId: ReadonlyMap<string, string>
  connectedPtyEvidence: ConnectedPtyEvidence
  retainedSnapshots: Iterable<RuntimeAgentRowSnapshot>
  hookSnapshots: readonly AgentStatusIpcPayload[]
  orchestrationByPaneKey: Record<string, OrchestrationDisplay> | null | undefined
  getSummary: (
    summaries: Map<string, RuntimeWorktreePsSummary>,
    pathIndex: RuntimeWorktreeSummaryPathIndex,
    missingWorktreeIds: Set<string>,
    worktreeId: string
  ) => RuntimeWorktreePsSummary | null
}): void {
  const rowSources = new Map<
    string,
    {
      paneKey: string
      ptyId?: string
      tabId?: string
      worktreeId?: string
      connectionId: string | null
      state: ParsedAgentStatusPayload['state']
      agentType: string | null
      prompt: string
      lastAssistantMessage: string | null
      toolName: string | null
      toolInput: string | null
      interrupted: boolean
      stateStartedAt: number
      updatedAt: number
      restoredUnconfirmed?: boolean
    }
  >()
  for (const snapshot of args.retainedSnapshots) {
    const { payload } = snapshot
    rowSources.set(snapshot.paneKey, {
      paneKey: snapshot.paneKey,
      ptyId: snapshot.ptyId,
      tabId: snapshot.tabId,
      worktreeId: snapshot.worktreeId,
      connectionId: snapshot.connectionId,
      state: payload.state,
      agentType: payload.agentType ?? null,
      prompt: payload.prompt,
      lastAssistantMessage: payload.lastAssistantMessage ?? null,
      toolName: payload.toolName ?? null,
      toolInput: payload.toolInput ?? null,
      interrupted: payload.interrupted ?? false,
      stateStartedAt: snapshot.stateStartedAt,
      updatedAt: snapshot.updatedAt
    })
  }
  for (const entry of args.hookSnapshots) {
    const existing = rowSources.get(entry.paneKey)
    if (existing && existing.updatedAt > entry.receivedAt) {
      continue
    }
    rowSources.set(entry.paneKey, {
      paneKey: entry.paneKey,
      ptyId: existing?.ptyId,
      tabId: entry.tabId,
      worktreeId: entry.worktreeId,
      connectionId: entry.connectionId,
      state: entry.state,
      agentType: entry.agentType ?? null,
      prompt: entry.prompt,
      lastAssistantMessage: entry.lastAssistantMessage ?? null,
      toolName: entry.toolName ?? null,
      toolInput: entry.toolInput ?? null,
      interrupted: entry.interrupted ?? false,
      stateStartedAt: entry.stateStartedAt,
      updatedAt: entry.receivedAt,
      ...(entry.restoredUnconfirmed ? { restoredUnconfirmed: true } : {})
    })
  }
  if (rowSources.size === 0) {
    return
  }
  const rowsByWorktree = new Map<string, RuntimeWorktreeAgentRow[]>()
  const now = Date.now()
  for (const source of rowSources.values()) {
    const tabId =
      source.tabId ??
      parsePaneKey(source.paneKey)?.tabId ??
      parseLegacyNumericPaneKey(source.paneKey)?.tabId
    const mirroredWorktreeId = tabId ? args.mirroredWorktreeIdByTabId.get(tabId) : undefined
    if (
      tabId !== undefined &&
      mirroredWorktreeId === undefined &&
      (source.connectionId === null || isWslHookRelayConnectionId(source.connectionId)) &&
      !args.connectedPtyEvidence.tabIds.has(tabId) &&
      !args.connectedPtyEvidence.paneKeys.has(source.paneKey) &&
      (source.ptyId === undefined || !args.connectedPtyEvidence.ptyIds.has(source.ptyId))
    ) {
      continue
    }
    const worktreeId = mirroredWorktreeId ?? source.worktreeId
    if (!worktreeId) {
      continue
    }
    const summary = args.getSummary(
      args.summaries,
      args.pathIndex,
      args.missingWorktreeIds,
      worktreeId
    )
    if (!summary) {
      continue
    }
    const orchestration = args.orchestrationByPaneKey?.[source.paneKey]
    const row: RuntimeWorktreeAgentRow = {
      paneKey: source.paneKey,
      parentPaneKey: orchestration?.parentPaneKey ?? null,
      state: source.state,
      agentType: source.agentType,
      prompt: source.prompt,
      taskTitle: orchestration?.taskTitle ?? null,
      displayName: orchestration?.displayName ?? null,
      lastAssistantMessage: source.lastAssistantMessage,
      toolName: source.toolName,
      toolInput: source.toolInput,
      interrupted: source.interrupted,
      stateStartedAt: source.stateStartedAt,
      updatedAt: source.updatedAt,
      ...(source.restoredUnconfirmed ? { restoredUnconfirmed: true } : {})
    }
    const rows = rowsByWorktree.get(summary.worktreeId)
    if (rows) {
      rows.push(row)
    } else {
      rowsByWorktree.set(summary.worktreeId, [row])
    }
  }
  for (const [worktreeId, rows] of rowsByWorktree) {
    rows.sort((a, b) => a.stateStartedAt - b.stateStartedAt)
    const summary = args.summaries.get(worktreeId)
    if (!summary) {
      continue
    }
    summary.agents = rows
    for (const row of rows) {
      if (!isFreshNonDoneAgentStatus(row, now)) {
        continue
      }
      summary.hasHostSidebarActivity = true
      summary.status = mergeWorktreeStatus(
        summary.status,
        row.state === 'working' ? 'working' : 'permission'
      )
    }
  }
}
