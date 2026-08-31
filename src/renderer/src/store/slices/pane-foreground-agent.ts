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
}

/** PTY-bound, time-bounded process evidence kept separate from the public identity record. */
export type PaneForegroundAgentObservation = {
  observedAt: number
  ptyId?: string
}

/**
 * Process-table identity for local panes, read at OSC 133 command boundaries
 * (see pane-foreground-agent-tracker). Sits below hook rows in the tab-icon
 * resolution; covers agents that emit neither hooks nor titles.
 */
export type PaneForegroundAgentSlice = {
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
  paneForegroundAgentObservationByPaneKey: Record<string, PaneForegroundAgentObservation>
  setPaneForegroundAgent: (
    paneKey: string,
    entry: PaneForegroundAgentEntry,
    observation?: PaneForegroundAgentObservation
  ) => void
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
  paneForegroundAgentObservationByPaneKey: {},
  setPaneForegroundAgent: (paneKey, entry, observation) => {
    set((s) => {
      const current = s.paneForegroundAgentByPaneKey[paneKey]
      if (
        current &&
        current.agent === entry.agent &&
        current.routingTrusted === entry.routingTrusted &&
        current.routingRevoked === entry.routingRevoked &&
        current.routingConfirmationPending === entry.routingConfirmationPending &&
        current.shellForeground === entry.shellForeground
      ) {
        if (!observation) {
          return s
        }
        const now = Date.now()
        const currentObservation = s.paneForegroundAgentObservationByPaneKey[paneKey]
        if (
          currentObservation &&
          currentObservation.ptyId === observation.ptyId &&
          now - currentObservation.observedAt < OBSERVATION_REFRESH_QUANTUM_MS
        ) {
          return s
        }
        return {
          paneForegroundAgentObservationByPaneKey: {
            ...s.paneForegroundAgentObservationByPaneKey,
            [paneKey]: { ...observation, observedAt: now }
          }
        }
      }
      const nextObservation = observation
        ? { ...observation }
        : entry.agent !== current?.agent || entry.shellForeground
          ? undefined
          : s.paneForegroundAgentObservationByPaneKey[paneKey]
      const nextObservations = { ...s.paneForegroundAgentObservationByPaneKey }
      if (nextObservation) {
        nextObservations[paneKey] = nextObservation
      } else {
        delete nextObservations[paneKey]
      }
      return {
        paneForegroundAgentByPaneKey: {
          ...s.paneForegroundAgentByPaneKey,
          [paneKey]: entry
        },
        paneForegroundAgentObservationByPaneKey: nextObservations
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
              [paneKey]: { agent, shellForeground: false }
            },
            paneForegroundAgentObservationByPaneKey: {
              ...s.paneForegroundAgentObservationByPaneKey,
              [paneKey]: { observedAt: now, ptyId }
            }
          }
        }
        const currentObservation = s.paneForegroundAgentObservationByPaneKey[paneKey]
        if (
          currentObservation &&
          now - currentObservation.observedAt < OBSERVATION_REFRESH_QUANTUM_MS
        ) {
          return s
        }
        return {
          paneForegroundAgentObservationByPaneKey: {
            ...s.paneForegroundAgentObservationByPaneKey,
            [paneKey]: { observedAt: now, ptyId: ptyId ?? currentObservation?.ptyId }
          }
        }
      }
      // Coordinator inspection proves identity but not input-routing authority.
      return {
        paneForegroundAgentByPaneKey: {
          ...s.paneForegroundAgentByPaneKey,
          [paneKey]: { agent, shellForeground: false }
        },
        paneForegroundAgentObservationByPaneKey: {
          ...s.paneForegroundAgentObservationByPaneKey,
          [paneKey]: { observedAt: now, ptyId }
        }
      }
    })
  },
  clearPaneForegroundAgent: (paneKey) => {
    set((s) => {
      if (
        !(paneKey in s.paneForegroundAgentByPaneKey) &&
        !(paneKey in s.paneForegroundAgentObservationByPaneKey)
      ) {
        return s
      }
      const next = { ...s.paneForegroundAgentByPaneKey }
      delete next[paneKey]
      const nextObservations = { ...s.paneForegroundAgentObservationByPaneKey }
      delete nextObservations[paneKey]
      return {
        paneForegroundAgentByPaneKey: next,
        paneForegroundAgentObservationByPaneKey: nextObservations
      }
    })
  },
  clearPaneForegroundAgentByTabPrefix: (tabIdPrefix) => {
    set(
      (s) =>
        buildPaneForegroundAgentTabPrefixClearPatch(
          s.paneForegroundAgentByPaneKey,
          s.paneForegroundAgentObservationByPaneKey,
          [`${tabIdPrefix}:`]
        ) ?? s
    )
  },
  clearPaneForegroundAgentByWorktree: (worktreeId) => {
    // Why: entries carry no worktreeId, so this must run while the worktree's
    // tabs are still in tabsByWorktree (removeWorktree prunes them only after
    // awaiting terminal teardown).
    set((s) => {
      const prefixes = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
      return (
        buildPaneForegroundAgentTabPrefixClearPatch(
          s.paneForegroundAgentByPaneKey,
          s.paneForegroundAgentObservationByPaneKey,
          prefixes
        ) ?? s
      )
    })
  }
})

/** Return process identity only while the evidence and its PTY are current. */
export function resolveFreshPaneForegroundAgent(
  entry: PaneForegroundAgentEntry | undefined,
  observation: PaneForegroundAgentObservation | undefined,
  args: { now: number; paneBoundPtyId?: string; liveTabPtyIds?: readonly string[] }
): TuiAgent | null {
  if (!entry?.agent || entry.shellForeground || !observation) {
    return null
  }
  if (args.now - observation.observedAt > PANE_FOREGROUND_AGENT_EVIDENCE_TTL_MS) {
    return null
  }
  if (args.paneBoundPtyId !== undefined) {
    return observation.ptyId === undefined || observation.ptyId === args.paneBoundPtyId
      ? entry.agent
      : null
  }
  if (observation.ptyId !== undefined) {
    return args.liveTabPtyIds?.includes(observation.ptyId) === true ? entry.agent : null
  }
  return (args.liveTabPtyIds?.length ?? 0) > 0 ? entry.agent : null
}

export function buildPaneForegroundAgentTabPrefixClearPatch(
  entries: Record<string, PaneForegroundAgentEntry>,
  observations: Record<string, PaneForegroundAgentObservation>,
  tabPrefixes: readonly string[]
): Pick<
  PaneForegroundAgentSlice,
  'paneForegroundAgentByPaneKey' | 'paneForegroundAgentObservationByPaneKey'
> | null {
  if (tabPrefixes.length === 0) {
    return null
  }
  const staleKeys = [
    ...new Set(
      [...Object.keys(entries), ...Object.keys(observations)].filter((paneKey) =>
        tabPrefixes.some((prefix) => paneKey.startsWith(prefix))
      )
    )
  ]
  if (staleKeys.length === 0) {
    return null
  }
  const next = { ...entries }
  const nextObservations = { ...observations }
  for (const paneKey of staleKeys) {
    delete next[paneKey]
    delete nextObservations[paneKey]
  }
  return {
    paneForegroundAgentByPaneKey: next,
    paneForegroundAgentObservationByPaneKey: nextObservations
  }
}
