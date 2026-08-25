import type { GitBranchCompareSummary } from '../../../../../../shared/git-diff-compare-types'
import type { WorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { translate } from '@/i18n/i18n'

function formatAheadOfTitle(count: number, ref: string): string {
  return count === 1
    ? translate(
        'auto.components.right.sidebar.SourceControl.f9b2441bb6',
        '1 commit ahead of {{value0}}',
        { value0: ref }
      )
    : translate(
        'auto.components.right.sidebar.SourceControl.b715ef615b',
        '{{value0}} commits ahead of {{value1}}',
        { value0: count, value1: ref }
      )
}

// Why: the count carries no color of its own. Green and red are reserved for the
// line-total chip beside it — an `↑1` in added-green next to `+1,114` reads as one
// quantity when they count different things (commits vs lines).
export type SourceControlBranchContextStat = {
  key: string
  label: string
  title: string
}

export function resolveSourceControlDisplayedBaseRef(
  summary: GitBranchCompareSummary | null | undefined,
  compareBaseRef: string | null | undefined
): string | null {
  const summaryRef = summary?.baseRef?.trim()
  if (summaryRef) {
    return summaryRef
  }
  const configuredRef = compareBaseRef?.trim()
  return configuredRef || null
}

// Why: context-row labels should stay scannable — drop git namespace prefixes
// but keep remote qualification (origin/main) so multi-remote bases stay distinct.
export function formatSourceControlRefLabel(ref: string): string {
  return ref
    .trim()
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/tags\//, '')
}

// Why: the compare row needs a displayable base; a summary alone with an empty
// baseRef would still fail the component's displayedBaseRef guard.
export function shouldShowSourceControlBranchContextRow(
  summary: GitBranchCompareSummary | null | undefined,
  compareBaseRef: string | null | undefined
): boolean {
  return resolveSourceControlDisplayedBaseRef(summary, compareBaseRef) != null
}

// Why: head-only identity still mounts when there is no base, so toolbar chrome
// visibility is "base OR head" — not base alone.
export function shouldShowSourceControlBranchContextChrome(
  summary: GitBranchCompareSummary | null | undefined,
  compareBaseRef: string | null | undefined,
  headDisplay: WorktreeGitIdentityDisplay | null | undefined
): boolean {
  return shouldShowSourceControlBranchContextRow(summary, compareBaseRef) || headDisplay != null
}

// Why: one count, on the line that names the ref it measures. Upstream ↑↓ used to
// ride alongside and were read against the base ref instead of the tracked branch.
export function buildSourceControlCompareBaseStats(
  summary: GitBranchCompareSummary | null | undefined,
  baseRef: string
): SourceControlBranchContextStat[] {
  if (summary?.status !== 'ready') {
    return []
  }
  const commitsAhead = summary.commitsAhead
  if (typeof commitsAhead !== 'number' || commitsAhead <= 0) {
    return []
  }
  const baseLabel = formatSourceControlRefLabel(baseRef)
  return [
    {
      key: 'compare-ahead',
      label: `↑${commitsAhead}`,
      title: formatAheadOfTitle(commitsAhead, baseLabel)
    }
  ]
}
