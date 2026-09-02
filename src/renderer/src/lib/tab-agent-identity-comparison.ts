import { useEffect } from 'react'
import { collectAgentTitleEvidence } from '../../../shared/agent-title-evidence'
import { resolveCanonicalPaneAgentIdentity } from '../../../shared/pane-agent-identity-adapter'
import {
  PaneAgentIdentityComparisonRecorder,
  type PaneIdentityComparisonInput
} from '../../../shared/pane-agent-identity-comparison'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * Tab-icon lane of the identity-ladder comparison window. The tab ladder is the one users
 * actually see and the one that ranks a parsed title above the launch record; this wrapper
 * computes the canonical answer beside the rendered one and counts where they disagree. The
 * rendered result is untouched — the caller passes it in and keeps displaying it.
 */

export type TabAgentLadderComparisonArgs = {
  tabId: string
  worktreeId?: string | null
  isRemote: boolean
  title: string
  hookAgent: TuiAgent | null
  siblingHookAgent?: TuiAgent | null
  focusedCompletedHookAgent?: TuiAgent | null
  siblingCompletedHookAgent?: TuiAgent | null
  /** Renderer foreground hint — no host process proof exists, so the canonical lane treats it as
   *  weak evidence rather than the process rung. */
  processAgent?: TuiAgent | null
  sleepingSessionAgent?: TuiAgent | null
  launchAgent?: TuiAgent | null
}

const defaultRecorder = new PaneAgentIdentityComparisonRecorder((line, sample) => {
  console.info(`[pane-identity-compare] ${line}`, sample ?? {})
})

export function getTabAgentLadderComparisonRecorder(): PaneAgentIdentityComparisonRecorder {
  return defaultRecorder
}

/** The tab's already-built ladder signals; a strict subset of `resolveTabAgentFromSignals` args. */
export type TabAgentLadderSignals = {
  isRemote: boolean
  title: string
  hookAgent: TuiAgent | null
  siblingHookAgent?: TuiAgent | null
  focusedCompletedHookAgent?: TuiAgent | null
  siblingCompletedHookAgent?: TuiAgent | null
  processAgent?: TuiAgent | null
  sleepingSessionAgent?: TuiAgent | null
  launchAgent?: TuiAgent | null
}

/** Post-render on purpose: render stays pure, the rendered icon stays untouched, and the
 *  recorder's signature gate keeps repeat commits free. */
export function useTabAgentLadderComparison(
  tabId: string,
  worktreeId: string | null | undefined,
  signals: TabAgentLadderSignals,
  renderedAgent: TuiAgent | null
): void {
  useEffect(() => {
    recordTabAgentLadderComparison(
      {
        tabId,
        worktreeId,
        isRemote: signals.isRemote,
        title: signals.title,
        hookAgent: signals.hookAgent,
        siblingHookAgent: signals.siblingHookAgent,
        focusedCompletedHookAgent: signals.focusedCompletedHookAgent,
        siblingCompletedHookAgent: signals.siblingCompletedHookAgent,
        processAgent: signals.processAgent,
        sleepingSessionAgent: signals.sleepingSessionAgent,
        launchAgent: signals.launchAgent ?? null
      },
      renderedAgent
    )
  })
}

export function recordTabAgentLadderComparison(
  args: TabAgentLadderComparisonArgs,
  renderedAgent: TuiAgent | null,
  recorder: PaneAgentIdentityComparisonRecorder = defaultRecorder
): void {
  try {
    const signature = [
      args.hookAgent ?? '-',
      args.siblingHookAgent ?? '-',
      args.focusedCompletedHookAgent ?? '-',
      args.siblingCompletedHookAgent ?? '-',
      args.processAgent ?? '-',
      args.sleepingSessionAgent ?? '-',
      args.launchAgent ?? '-',
      String(args.isRemote),
      renderedAgent ?? '-',
      args.title
    ].join('|')
    if (!recorder.shouldCompare('tab-icon', args.tabId, signature)) {
      return
    }
    const canonical = resolveCanonicalPaneAgentIdentity({
      hookAgent: args.hookAgent,
      hookIsLive: true,
      completedHookAgent: args.focusedCompletedHookAgent,
      launchAgent: args.launchAgent,
      foregroundAgent: args.processAgent,
      sleepingSessionAgent: args.sleepingSessionAgent,
      siblingAgent: args.siblingHookAgent ?? args.siblingCompletedHookAgent,
      allowSibling: true,
      title: args.title,
      uncoveredFallback: { agent: renderedAgent }
    })
    const titleAgent = args.title ? collectAgentTitleEvidence(args.title).agent : null
    const input: PaneIdentityComparisonInput = {
      surface: 'tab-icon',
      paneId: args.tabId,
      worktreeId: args.worktreeId,
      oldAgent: renderedAgent,
      newAgent: canonical.agent,
      newSource: canonical.source,
      coverage: canonical.coverage,
      titleOnly: canonical.titleOnly,
      // Run keys reach the tab ladder with a later wave; absent means absent, not stale.
      runKeyComparability: 'absent',
      hostScope: args.isRemote ? 'remote' : 'local',
      ambiguous: canonical.ambiguousAt !== undefined,
      reclaimShape: Boolean(
        args.focusedCompletedHookAgent &&
        titleAgent &&
        titleAgent !== args.focusedCompletedHookAgent
      )
    }
    recorder.record(input)
  } catch {
    // Comparison telemetry must never break the tab bar; a lost sample is recoverable.
  }
}
