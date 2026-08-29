import type { AppState } from '../types'
import {
  WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupScanError,
  type WorkspaceCleanupUnverifiedRemovalConsent
} from '../../../../shared/workspace-cleanup'
import type { WorkspaceCleanupRepoListing } from '../../../../shared/workspace-cleanup-omission-verdict'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import {
  evaluateWorkspaceCleanupPreflight,
  type WorkspaceCleanupPreflightResult,
  type WorkspaceCleanupRemovalTarget
} from './workspace-cleanup-removal-targets'

/**
 * The rescan every removal runs before it deletes anything, and the only place
 * the preflight's picture of the workspaces comes from. It carries forward what
 * the scan reported *about the scan* as well as the rows it found, because an
 * omission means one thing from a host that answered and nothing at all from one
 * that did not.
 */
export async function preflightWorkspaceCleanupCandidates(
  targets: readonly WorkspaceCleanupRemovalTarget[],
  getState: () => AppState,
  enrich: (
    candidates: readonly WorkspaceCleanupCandidate[],
    state: AppState
  ) => Promise<WorkspaceCleanupCandidate[]>,
  options: {
    unverifiedRemovalConsent?: WorkspaceCleanupUnverifiedRemovalConsent
    getConsentAttemptId?: (identity: string) => string | undefined
  } = {}
): Promise<WorkspaceCleanupPreflightResult[]> {
  // Why: one batched scan per chunk replaces a git worktree-list + activity
  // read per row; chunks stay under main's silent target truncation limit.
  const candidatesByIdentity = new Map<string, WorkspaceCleanupCandidate>()
  const identitiesByWorktreeId = new Map<string, Set<string>>()
  const errors: WorkspaceCleanupScanError[] = []
  const repoListings: WorkspaceCleanupRepoListing[] = []
  const worktreeIds = targets.map((target) => target.worktreeId)
  for (let start = 0; start < worktreeIds.length; start += WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT) {
    const chunk = worktreeIds.slice(start, start + WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT)
    const scan = await window.api.workspaceCleanup.scan({
      worktreeIds: [...chunk],
      scanId: crypto.randomUUID(),
      refreshActivity: true
    })
    const enriched = await enrich(scan.candidates, getState())
    errors.push(...scan.errors)
    repoListings.push(...(scan.repoListings ?? []))
    for (const candidate of enriched) {
      const identity = getWorkspaceCleanupCandidateIdentity(candidate)
      candidatesByIdentity.set(identity, candidate)
      const identities = identitiesByWorktreeId.get(candidate.worktreeId) ?? new Set<string>()
      identities.add(identity)
      identitiesByWorktreeId.set(candidate.worktreeId, identities)
    }
  }
  return targets.map((target) =>
    evaluateWorkspaceCleanupPreflight(
      target,
      candidatesByIdentity,
      identitiesByWorktreeId,
      { errors, repoListings },
      options
    )
  )
}
