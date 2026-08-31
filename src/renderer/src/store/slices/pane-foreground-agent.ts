import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/tui-agent'

// Process identity is attribution evidence, not a permanent status row. Keep
// it fresh enough for sidebar projections while bounded when observations stop.
export const PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS = 30_000
const OBSERVATION_REFRESH_QUANTUM_MS = 5_000

export type PaneForegroundAgentEntry = {
  /** Recognized agent process in the pane's foreground; null when unknown. */
  agent: TuiAgent | null
  /** True only when fresh provider evidence is safe for input-byte routing. */
  routingTrusted?: boolean
  /** True after exit/input evidence revokes routing until provider confirmation. */
  routingRevoked?: boolean
  /** True while previously trusted routing awaits provider revalidation. Retains
   *  Shift+Enter byte capability only — the Ctrl+Enter resolver deliberately does
   *  not read it, because its fallback is a plain CR that submits either way. */
  routingConfirmationPending?: boolean
  /** True once the foreground is proven back at the shell (OSC 133;D) —
   *  process-grade launched-agent exit evidence, independent of titles. */
  shellForeground: boolean
  /** Main-clock timestamp for the process observation. */
  observedAt?: number
  /** PTY from which the process observation was read. */
  ptyId?: string
}

/**
 * Process-table identity for local panes, read at OSC 133 command boundaries
 * (see pane-foreground-agent-tracker). Sits below hook rows in the tab-icon
 * resolution; covers agents that emit neither hooks nor titles.
 */
export type PaneForegroundAgentSlice = {
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
  setPaneForegroundAgent: (paneKey: string, entry: PaneForegroundAgentEntry) => void
  refreshPaneForegroundAgentObservation: (paneKey: string, agent: TuiAgent, ptyId?: string) => void
  clearPaneForegroundAgent: (paneKey: string) => void
  /** Wholesale teardown sweeps (tab close, worktree sleep/remove) retire pane
   *  keys without per-pane close events — clear their entries too. */
  clearPaneForegroundAgentByTabPrefix: (tabIdPrefix: string) => void
  clearPaneForegroundAgentByWorktree: (worktreeId: string) => void
}

export const createPaneForegroundAgentSlice: StateCreator<
  AppState,
  [],
  [],
  PaneForegroundAgentSlice
> = (set) => ({
  paneForegroundAgentByPaneKey: {},
  setPaneForegroundAgent: (paneKey, entry) => {
    set((s) => {
      const current = s.paneForegroundAgentByPaneKey[paneKey]
      if (
        current &&
        current.agent === entry.agent &&
        current.routingTrusted === entry.routingTrusted &&
        current.routingRevoked === entry.routingRevoked &&
        current.routingConfirmationPending === entry.routingConfirmationPending &&
        current.shellForeground === entry.shellForeground &&
        current.ptyId === entry.ptyId
      ) {
        // Test/legacy callers may provide identity-only entries. Preserve the
        // value-bail semantics for those records; only observed process
        // evidence opts into the bounded freshness clock.
        if (current.observedAt === undefined && entry.observedAt === undefined) {
          return s
        }
        const now = Date.now()
        if (
          current.observedAt !== undefined &&
          now - current.observedAt < OBSERVATION_REFRESH_QUANTUM_MS
        ) {
          return s
        }
        return {
          paneForegroundAgentByPaneKey: {
            ...s.paneForegroundAgentByPaneKey,
            [paneKey]: { ...current, observedAt: now }
          }
        }
      }
      return {
        paneForegroundAgentByPaneKey: {
          ...s.paneForegroundAgentByPaneKey,
          [paneKey]: entry
        }
      }
    })
  },
  refreshPaneForegroundAgentObservation: (paneKey, agent, ptyId) => {
    set((s) => {
      const now = Date.now()
      const current = s.paneForegroundAgentByPaneKey[paneKey]
      if (current) {
        if (current.agent !== agent) {
          return {
            paneForegroundAgentByPaneKey: {
              ...s.paneForegroundAgentByPaneKey,
              [paneKey]: {
                agent,
                shellForeground: false,
                observedAt: now,
                ptyId: ptyId ?? current.ptyId
              }
            }
          }
        }
        if (
          current.observedAt !== undefined &&
          now - current.observedAt < OBSERVATION_REFRESH_QUANTUM_MS
        ) {
          return s
        }
        return {
          paneForegroundAgentByPaneKey: {
            ...s.paneForegroundAgentByPaneKey,
            [paneKey]: { ...current, observedAt: now }
          }
        }
      }
      // Coordinator inspection proves identity but not input-routing authority.
      return {
        paneForegroundAgentByPaneKey: {
          ...s.paneForegroundAgentByPaneKey,
          [paneKey]: { agent, shellForeground: false, observedAt: now }
        }
      }
    })
  },
  clearPaneForegroundAgent: (paneKey) => {
    set((s) => {
      if (!(paneKey in s.paneForegroundAgentByPaneKey)) {
        return s
      }
      const next = { ...s.paneForegroundAgentByPaneKey }
      delete next[paneKey]
      return { paneForegroundAgentByPaneKey: next }
    })
  },
  clearPaneForegroundAgentByTabPrefix: (tabIdPrefix) => {
    set(
      (s) =>
        buildPaneForegroundAgentTabPrefixClearPatch(s.paneForegroundAgentByPaneKey, [
          `${tabIdPrefix}:`
        ]) ?? s
    )
  },
  clearPaneForegroundAgentByWorktree: (worktreeId) => {
    // Why: entries carry no worktreeId, so this must run while the worktree's
    // tabs are still in tabsByWorktree (removeWorktree prunes them only after
    // awaiting terminal teardown).
    set((s) => {
      const prefixes = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
      return (
        buildPaneForegroundAgentTabPrefixClearPatch(s.paneForegroundAgentByPaneKey, prefixes) ?? s
      )
    })
  }
})

/** Return process identity only while the evidence and its PTY are current. */
export function resolveFreshPaneForegroundAgent(
  entry: PaneForegroundAgentEntry | undefined,
  args: { now: number; paneBoundPtyId?: string; liveTabPtyIds?: readonly string[] }
): TuiAgent | null {
  if (!entry?.agent || entry.shellForeground || entry.observedAt === undefined) {
    return null
  }
  if (args.now - entry.observedAt > PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS) {
    return null
  }
  if (args.paneBoundPtyId !== undefined) {
    return entry.ptyId === undefined || entry.ptyId === args.paneBoundPtyId ? entry.agent : null
  }
  if (entry.ptyId !== undefined) {
    return args.liveTabPtyIds?.includes(entry.ptyId) === true ? entry.agent : null
  }
  return (args.liveTabPtyIds?.length ?? 0) > 0 ? entry.agent : null
}

export function buildPaneForegroundAgentTabPrefixClearPatch(
  entries: Record<string, PaneForegroundAgentEntry>,
  tabPrefixes: readonly string[]
): Pick<PaneForegroundAgentSlice, 'paneForegroundAgentByPaneKey'> | null {
  if (tabPrefixes.length === 0) {
    return null
  }
  const staleKeys = Object.keys(entries).filter((paneKey) =>
    tabPrefixes.some((prefix) => paneKey.startsWith(prefix))
  )
  if (staleKeys.length === 0) {
    return null
  }
  const next = { ...entries }
  for (const paneKey of staleKeys) {
    delete next[paneKey]
  }
  return { paneForegroundAgentByPaneKey: next }
}
