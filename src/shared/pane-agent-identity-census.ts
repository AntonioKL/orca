import { collectAgentTitleEvidence } from './agent-title-evidence'
import type { CollectedPaneAgentIdentityEvidence } from './pane-agent-identity-evidence'
import {
  PANE_AGENT_EVIDENCE_SOURCES,
  resolvePaneAgentIdentity,
  type PaneAgentEvidenceSource
} from './pane-agent-identity-resolver'
import { resolveExplicitTerminalTitleAgentType } from './terminal-title-agent-type'

export const PANE_AGENT_IDENTITY_HOST_KINDS = [
  'native',
  'wsl-host',
  'wsl-distro',
  'ssh',
  'relay'
] as const
export type PaneAgentIdentityHostKind = (typeof PANE_AGENT_IDENTITY_HOST_KINDS)[number]

export const PANE_AGENT_IDENTITY_LAUNCH_MODES = [
  'typed',
  'orca-launch',
  'resume',
  'unknown'
] as const
export type PaneAgentIdentityLaunchMode = (typeof PANE_AGENT_IDENTITY_LAUNCH_MODES)[number]

export type PaneAgentRunKeyAvailability = 'present' | 'old-peer' | 'missing'

export type PaneAgentIdentityAvailabilityObservation = {
  hostKind: PaneAgentIdentityHostKind
  launchMode: PaneAgentIdentityLaunchMode
  runKeyAvailability: PaneAgentRunKeyAvailability
  collected: CollectedPaneAgentIdentityEvidence
}

export type PaneAgentIdentityAvailabilityRow = {
  hostKind: PaneAgentIdentityHostKind
  launchMode: PaneAgentIdentityLaunchMode
  sourceMask: number
  snapshots: number
  noEvidence: number
  titleOnly: number
  noNonTitleEvidence: number
  ambiguousTopRank: number
  oldPeerOrNoRunKey: number
}

const SOURCE_BITS = new Map<PaneAgentEvidenceSource, number>(
  PANE_AGENT_EVIDENCE_SOURCES.map((source, index) => [source, 1 << index])
)

export function getPaneAgentEvidenceSourceMask(
  collected: CollectedPaneAgentIdentityEvidence
): number {
  return collected.evidence.reduce((mask, item) => mask | (SOURCE_BITS.get(item.source) ?? 0), 0)
}

function availabilityKey(
  hostKind: PaneAgentIdentityHostKind,
  launchMode: PaneAgentIdentityLaunchMode,
  sourceMask: number
): string {
  return `${hostKind}\0${launchMode}\0${sourceMask}`
}

/** Retains aggregate source presence only; no pane, title, prompt, path, handle, or agent value. */
export class PaneAgentIdentityAvailabilityCensus {
  private readonly rows = new Map<string, PaneAgentIdentityAvailabilityRow>()

  observe(observation: PaneAgentIdentityAvailabilityObservation): void {
    const sourceMask = getPaneAgentEvidenceSourceMask(observation.collected)
    const key = availabilityKey(observation.hostKind, observation.launchMode, sourceMask)
    const row = this.rows.get(key) ?? {
      hostKind: observation.hostKind,
      launchMode: observation.launchMode,
      sourceMask,
      snapshots: 0,
      noEvidence: 0,
      titleOnly: 0,
      noNonTitleEvidence: 0,
      ambiguousTopRank: 0,
      oldPeerOrNoRunKey: 0
    }
    const sources = observation.collected.evidence.map((item) => item.source)
    const resolution = resolvePaneAgentIdentity({ evidence: observation.collected.evidence })
    row.snapshots += 1
    row.noEvidence += sources.length === 0 ? 1 : 0
    row.titleOnly += sources.length > 0 && sources.every((source) => source === 'title') ? 1 : 0
    row.noNonTitleEvidence += sources.every((source) => source === 'title') ? 1 : 0
    row.ambiguousTopRank += resolution.ambiguousAt === undefined ? 0 : 1
    row.oldPeerOrNoRunKey += observation.runKeyAvailability === 'present' ? 0 : 1
    this.rows.set(key, row)
  }

  snapshot(): readonly PaneAgentIdentityAvailabilityRow[] {
    return [...this.rows.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) =>
        availabilityKey(a.hostKind, a.launchMode, a.sourceMask).localeCompare(
          availabilityKey(b.hostKind, b.launchMode, b.sourceMask)
        )
      )
  }
}

export const AGENT_TITLE_PARSER_DIFFERENTIAL_CATEGORIES = [
  'agreement',
  'legacy-only',
  'canonical-only',
  'disagreement'
] as const
export type AgentTitleParserDifferentialCategory =
  (typeof AGENT_TITLE_PARSER_DIFFERENTIAL_CATEGORIES)[number]

export function classifyAgentTitleParserDifferential(
  title: string
): AgentTitleParserDifferentialCategory {
  const legacy = resolveExplicitTerminalTitleAgentType(title)
  const canonical = collectAgentTitleEvidence(title).agent
  if (legacy === canonical) {
    return 'agreement'
  }
  if (legacy !== null && canonical === null) {
    return 'legacy-only'
  }
  if (legacy === null) {
    return 'canonical-only'
  }
  return 'disagreement'
}

export type AgentTitleParserDifferentialSnapshot = Record<
  AgentTitleParserDifferentialCategory,
  number
>

/** Counts parser outcomes and immediately discards the source title and both identities. */
export class AgentTitleParserDifferentialCensus {
  private readonly counts: AgentTitleParserDifferentialSnapshot = {
    agreement: 0,
    'legacy-only': 0,
    'canonical-only': 0,
    disagreement: 0
  }

  observe(title: string): void {
    this.counts[classifyAgentTitleParserDifferential(title)] += 1
  }

  snapshot(): AgentTitleParserDifferentialSnapshot {
    return { ...this.counts }
  }
}
