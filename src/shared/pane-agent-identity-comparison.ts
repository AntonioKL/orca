import type { PaneAgentCoverage } from './pane-agent-identity-adapter'
import type { PaneAgentEvidenceSource } from './pane-agent-identity-resolver'

/**
 * Comparison telemetry for the identity-ladder migration: where do the old and canonical ladders
 * DISAGREE on real sessions? Recorded BEFORE any surface changes what it displays, so each later
 * flip is a measured decision instead of a guess.
 *
 * Privacy contract: emitted records carry pseudonymous salted ids, agent enum values, sources,
 * coverage, and counters — never raw titles, prompts, commands, file paths, or tokens.
 */

export type PaneIdentityComparisonSurface = 'terminal-summary' | 'pty-terminal-summary' | 'tab-icon'

export type PaneIdentityRunKeyComparability = 'comparable' | 'incomparable' | 'absent'

export type PaneIdentityHostScope = 'local' | 'remote' | 'unknown'

export type PaneIdentityComparisonInput = {
  surface: PaneIdentityComparisonSurface
  /** Raw pane/tab identifier; pseudonymized before it reaches any emitted record. */
  paneId: string
  worktreeId?: string | null
  oldAgent: string | null
  newAgent: string | null
  newSource: PaneAgentEvidenceSource | null
  coverage: PaneAgentCoverage
  titleOnly: boolean
  runKeyComparability: PaneIdentityRunKeyComparability
  hostScope: PaneIdentityHostScope
  /** The canonical resolver saw equally-ranked conflicting evidence. */
  ambiguous: boolean
  /** The bug-versus-reclaim input shape: a completed hook naming A beside a title naming B. */
  reclaimShape: boolean
}

export type PaneIdentityComparisonCounters = {
  comparisons: number
  disagreements: number
  ambiguous: number
  reclaimShapes: number
  /** Flipping would turn a published absence into a presence — `groups.ts` reads absence as NO. */
  oldAbsentNewPresent: number
  oldPresentNewAbsent: number
  titleOnly: number
  uncovered: number
}

const MAX_PANE_SIGNATURES = 2048
const MAX_DISAGREEMENT_KEYS = 40
/** Counter snapshots go out on a log scale so a busy session cannot flood the sink. */
const SNAPSHOT_AT = [100, 1_000, 10_000, 100_000, 1_000_000]

function pseudonymize(salt: string, value: string): string {
  // djb2: stable within one process, meaningless outside it. Pseudonymity, not secrecy — the raw
  // id never leaves the process either way.
  let hash = 5381
  const input = `${salt}:${value}`
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export class PaneAgentIdentityComparisonRecorder {
  private readonly counters: PaneIdentityComparisonCounters = {
    comparisons: 0,
    disagreements: 0,
    ambiguous: 0,
    reclaimShapes: 0,
    oldAbsentNewPresent: 0,
    oldPresentNewAbsent: 0,
    titleOnly: 0,
    uncovered: 0
  }
  private readonly lastSignatureByPane = new Map<string, string>()
  private readonly emittedDisagreementKeys = new Set<string>()
  private readonly salt: string

  constructor(
    private readonly emit: (line: string, sample?: Record<string, unknown>) => void = () => {}
  ) {
    this.salt = globalThis.crypto.randomUUID()
  }

  /**
   * Consecutive-duplicate gate, cheap enough for a render/summary path: callers build a signature
   * from the ladder INPUTS and skip the (costlier) canonical resolution when nothing changed.
   */
  shouldCompare(
    surface: PaneIdentityComparisonSurface,
    paneId: string,
    signature: string
  ): boolean {
    const key = `${surface}|${paneId}`
    if (this.lastSignatureByPane.get(key) === signature) {
      return false
    }
    this.lastSignatureByPane.set(key, signature)
    while (this.lastSignatureByPane.size > MAX_PANE_SIGNATURES) {
      const oldest = this.lastSignatureByPane.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.lastSignatureByPane.delete(oldest)
    }
    return true
  }

  record(input: PaneIdentityComparisonInput): void {
    this.counters.comparisons += 1
    if (input.ambiguous) {
      this.counters.ambiguous += 1
    }
    if (input.reclaimShape) {
      this.counters.reclaimShapes += 1
    }
    if (input.titleOnly) {
      this.counters.titleOnly += 1
    }
    if (input.coverage === 'uncovered') {
      this.counters.uncovered += 1
    }
    const disagrees = input.oldAgent !== input.newAgent
    if (disagrees) {
      this.counters.disagreements += 1
      if (input.oldAgent === null) {
        this.counters.oldAbsentNewPresent += 1
      }
      if (input.newAgent === null) {
        this.counters.oldPresentNewAbsent += 1
      }
      this.emitDisagreement(input)
    }
    if (SNAPSHOT_AT.includes(this.counters.comparisons)) {
      this.emit('pane-identity-compare counters', { ...this.counters })
    }
  }

  snapshot(): PaneIdentityComparisonCounters {
    return { ...this.counters }
  }

  private emitDisagreement(input: PaneIdentityComparisonInput): void {
    const key = [
      input.surface,
      input.oldAgent ?? '-',
      input.newAgent ?? '-',
      input.newSource ?? '-',
      input.coverage,
      input.hostScope
    ].join('|')
    // One detail record per distinct disagreement shape, hard-capped; repeats only count.
    if (
      this.emittedDisagreementKeys.has(key) ||
      this.emittedDisagreementKeys.size >= MAX_DISAGREEMENT_KEYS
    ) {
      return
    }
    this.emittedDisagreementKeys.add(key)
    this.emit('pane-identity-compare disagreement', {
      surface: input.surface,
      pane: pseudonymize(this.salt, input.paneId),
      ...(input.worktreeId ? { worktree: pseudonymize(this.salt, input.worktreeId) } : {}),
      oldAgent: input.oldAgent,
      newAgent: input.newAgent,
      newSource: input.newSource,
      coverage: input.coverage,
      titleOnly: input.titleOnly,
      runKeyComparability: input.runKeyComparability,
      hostScope: input.hostScope,
      ambiguous: input.ambiguous,
      reclaimShape: input.reclaimShape
    })
  }
}
