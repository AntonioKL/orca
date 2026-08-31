import { collectAgentTitleEvidence } from './agent-title-evidence'
import { resolveCanonicalPaneAgentIdentity } from './pane-agent-identity-adapter'
import {
  PaneAgentIdentityComparisonRecorder,
  type PaneIdentityComparisonSurface,
  type PaneIdentityHostScope
} from './pane-agent-identity-comparison'
import { resolvePublishedPaneAgentIdentity } from './published-pane-agent-identity'
import type { TuiAgent } from './tui-agent'

/**
 * Output-neutral wrapper for the host publication path. The FROZEN adapter still decides what is
 * published — this function returns its result verbatim — while the canonical adapter's answer is
 * computed beside it and only disagreements are counted. `RuntimeTerminalSummary.agentIdentity`
 * must not change while the comparison window runs.
 */

export type PublishedPaneAgentIdentityComparisonArgs = {
  hookAgent?: TuiAgent | null
  hookIsLive?: boolean
  launchAgent?: TuiAgent | null
  foregroundAgent?: TuiAgent | null
  title?: string | null
  surface: PaneIdentityComparisonSurface
  paneId: string
  worktreeId?: string | null
  hostScope: PaneIdentityHostScope
}

const defaultRecorder = new PaneAgentIdentityComparisonRecorder((line, sample) => {
  console.info(`[pane-identity-compare] ${line}`, sample ?? {})
})

export function getPublishedPaneIdentityComparisonRecorder(): PaneAgentIdentityComparisonRecorder {
  return defaultRecorder
}

export function comparePublishedPaneAgentIdentity(
  args: PublishedPaneAgentIdentityComparisonArgs,
  recorder: PaneAgentIdentityComparisonRecorder = defaultRecorder
): TuiAgent | undefined {
  const published = resolvePublishedPaneAgentIdentity(args)
  try {
    recordCanonicalDivergence(args, published ?? null, recorder)
  } catch {
    // Telemetry must never take down terminal.list; a lost sample is recoverable.
  }
  return published
}

function recordCanonicalDivergence(
  args: PublishedPaneAgentIdentityComparisonArgs,
  published: TuiAgent | null,
  recorder: PaneAgentIdentityComparisonRecorder
): void {
  const signature = [
    args.hookAgent ?? '-',
    args.hookIsLive === true ? 'live' : 'idle',
    args.launchAgent ?? '-',
    args.foregroundAgent ?? '-',
    args.title ?? '-'
  ].join('|')
  if (!recorder.shouldCompare(args.surface, args.paneId, signature)) {
    return
  }
  // No host process PROOF exists yet, so the canonical lane sees the foreground name as a weak
  // hint only. Where that alone flips the answer is precisely what this window measures.
  const canonical = resolveCanonicalPaneAgentIdentity({
    hookAgent: args.hookAgent,
    hookIsLive: args.hookIsLive,
    launchAgent: args.launchAgent,
    foregroundAgent: args.foregroundAgent,
    title: args.title,
    uncoveredFallback: { agent: published, titleOnly: published !== null }
  })
  const titleAgent = args.title ? collectAgentTitleEvidence(args.title).agent : null
  recorder.record({
    surface: args.surface,
    paneId: args.paneId,
    worktreeId: args.worktreeId,
    oldAgent: published,
    newAgent: canonical.agent,
    newSource: canonical.source,
    coverage: canonical.coverage,
    titleOnly: canonical.titleOnly,
    // Run keys are not plumbed into the publication path yet (host wave); absent, not stale.
    runKeyComparability: 'absent',
    hostScope: args.hostScope,
    ambiguous: canonical.ambiguousAt !== undefined,
    reclaimShape: Boolean(
      args.hookAgent && args.hookIsLive !== true && titleAgent && titleAgent !== args.hookAgent
    )
  })
}
