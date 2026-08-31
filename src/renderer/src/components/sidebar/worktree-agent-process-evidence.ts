import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import {
  resolveFreshPaneForegroundAgent,
  type PaneForegroundAgentEntry,
  type PaneForegroundAgentObservation
} from '@/store/slices/pane-foreground-agent'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'

/** Identity-only observations need a distinct authority from title snapshots. */
export const PROCESS_DERIVED_AGENT_ROW_AUTHORITY_ID = 'renderer-process-projection'

export function freshProcessAgentForLeaf(args: {
  tabId: string
  leafId: string
  layout: TerminalLayoutSnapshot | undefined
  livePtyIds: readonly string[] | undefined
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry> | undefined
  paneForegroundAgentObservationByPaneKey:
    | Record<string, PaneForegroundAgentObservation>
    | undefined
  now: number
}): TuiAgent | null {
  if (!args.paneForegroundAgentByPaneKey || !isTerminalLeafId(args.leafId)) {
    return null
  }
  return resolveFreshPaneForegroundAgent(
    args.paneForegroundAgentByPaneKey[makePaneKey(args.tabId, args.leafId)],
    args.paneForegroundAgentObservationByPaneKey?.[makePaneKey(args.tabId, args.leafId)],
    {
      now: args.now,
      paneBoundPtyId: args.layout?.ptyIdsByLeafId?.[args.leafId],
      liveTabPtyIds: args.livePtyIds
    }
  )
}

/** Append identity-only rows for fresh process observations that have no hook/title row. */
export function appendProcessDerivedAgentRows(args: {
  tabs: TerminalTab[]
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry> | undefined
  paneForegroundAgentObservationByPaneKey:
    | Record<string, PaneForegroundAgentObservation>
    | undefined
  seenPaneKeys: Set<string>
  rows: DashboardAgentRow[]
  now: number
}): void {
  for (const [paneKey] of Object.entries(args.paneForegroundAgentByPaneKey ?? {})) {
    if (args.seenPaneKeys.has(paneKey)) {
      continue
    }
    const parsed = parsePaneKey(paneKey)
    if (!parsed) {
      continue
    }
    const tab = args.tabs.find((candidate) => candidate.id === parsed.tabId)
    if (!tab || !tabHasLivePty(args.ptyIdsByTabId, tab.id)) {
      continue
    }
    const processAgent = freshProcessAgentForLeaf({
      tabId: tab.id,
      leafId: parsed.leafId,
      layout: args.terminalLayoutsByTabId[tab.id],
      livePtyIds: args.ptyIdsByTabId[tab.id],
      paneForegroundAgentByPaneKey: args.paneForegroundAgentByPaneKey,
      paneForegroundAgentObservationByPaneKey: args.paneForegroundAgentObservationByPaneKey,
      now: args.now
    })
    if (!processAgent) {
      continue
    }
    args.rows.push(
      buildProcessDerivedAgentRow({
        tab,
        leafId: parsed.leafId,
        agent: processAgent,
        now: args.now
      })
    )
    args.seenPaneKeys.add(paneKey)
  }
}

function buildProcessDerivedAgentRow(args: {
  tab: TerminalTab
  leafId: string
  agent: TuiAgent
  now: number
}): DashboardAgentRow {
  const paneKey = makePaneKey(args.tab.id, args.leafId)
  const label = formatAgentTypeLabel(args.agent)
  const entry: AgentStatusEntry = {
    paneKey,
    state: 'working',
    prompt: label,
    updatedAt: args.now,
    stateStartedAt: args.now,
    stateHistory: [],
    agentType: args.agent,
    terminalTitle: args.tab.title,
    lastAssistantMessage: 'Idle',
    observation: {
      origin: 'process',
      authorityId: PROCESS_DERIVED_AGENT_ROW_AUTHORITY_ID,
      incarnation: 0,
      revision: args.now,
      observedAt: args.now,
      kind: 'snapshot'
    }
  }
  return {
    paneKey,
    entry,
    tab: args.tab,
    agentType: args.agent,
    rowSource: 'live',
    state: 'idle',
    startedAt: args.now
  }
}
