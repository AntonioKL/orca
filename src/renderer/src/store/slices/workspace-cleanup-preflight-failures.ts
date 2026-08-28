import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  WorkspaceCleanupBlocker,
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanError,
  WorkspaceCleanupUnverifiedRemovalConsent
} from '../../../../shared/workspace-cleanup'
import { shouldForceWorkspaceCleanupRemoval } from '../../../../shared/workspace-cleanup'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupFailure } from './workspace-cleanup'

type PreflightFailureTarget = {
  worktreeId: string
  executionHostId: ExecutionHostId | null
  displayName: string
}

export function getWorkspaceCleanupMissingFailure(
  target: PreflightFailureTarget
): WorkspaceCleanupFailure {
  return {
    worktreeId: target.worktreeId,
    ...(target.executionHostId ? { executionHostId: target.executionHostId } : {}),
    displayName: target.displayName,
    message: translate(
      'auto.store.slices.workspace.cleanup.9d6e531da6',
      'Workspace no longer exists.'
    )
  }
}

/**
 * Why the removal must stop, when the rescan the user never saw changed the
 * picture they confirmed against. `null` when nothing new appeared — a verdict
 * the confirmed row already carried is still covered by that consent.
 *
 * Each message states the verdict the preflight holds now. A verdict absent from
 * the approved snapshot need not have *arisen* after the confirmation — that
 * snapshot may simply never have observed it — so no message claims it did.
 *
 * The liveness messages stay distinct from each other because the verdicts are:
 * `running-terminal` and `live-agent` are positive evidence of live work, while
 * `terminal-liveness-unknown` is loss of contact, which is never evidence that
 * anything is running.
 */
export function getWorkspaceCleanupPostConfirmationMessage(
  candidate: WorkspaceCleanupCandidate,
  approvedCandidate: WorkspaceCleanupCandidate
): string | null {
  const added = (blocker: WorkspaceCleanupBlocker): boolean =>
    candidate.blockers.includes(blocker) && !approvedCandidate.blockers.includes(blocker)
  if (
    (shouldForceWorkspaceCleanupRemoval(candidate) &&
      !shouldForceWorkspaceCleanupRemoval(approvedCandidate)) ||
    WORKSPACE_CLEANUP_CONCRETE_RISK_BLOCKERS.some(added)
  ) {
    return translate(
      'auto.store.slices.workspace.cleanup.changedSinceConfirmation',
      'Workspace changed after confirmation. Refresh to review it before removing.'
    )
  }
  if (WORKSPACE_CLEANUP_LIVE_WORK_BLOCKERS.some(added)) {
    return translate(
      'auto.store.slices.workspace.cleanup.liveWorkSinceConfirmation',
      'A terminal or agent in this workspace is running. Review it before removing.'
    )
  }
  // Blocks without proving risk: the confirm screen names this verdict, so a row
  // confirmed while its terminal read idle was authorized on evidence the
  // preflight no longer has. Deleting anyway spends consent the user never gave.
  if (!added('terminal-liveness-unknown')) {
    return null
  }
  return translate(
    'auto.store.slices.workspace.cleanup.livenessUnverifiableSinceConfirmation',
    "Orca cannot verify this workspace's terminals. Review it before removing."
  )
}

export function hasValidWorkspaceCleanupUnverifiedConsent(
  candidateIdentity: string,
  consent: WorkspaceCleanupUnverifiedRemovalConsent | undefined,
  getConsentAttemptId: ((identity: string) => string | undefined) | undefined
): boolean {
  return Boolean(
    consent &&
    consent.identity === candidateIdentity &&
    getConsentAttemptId?.(consent.identity) === consent.attemptId
  )
}

export function getWorkspaceCleanupRepoScanFailure(
  target: PreflightFailureTarget,
  errors: readonly WorkspaceCleanupScanError[]
): WorkspaceCleanupFailure | null {
  const error = errors.find(
    (entry) =>
      entry.repoId === getRepoIdFromWorktreeId(target.worktreeId) &&
      (!entry.executionHostId ||
        target.executionHostId === null ||
        entry.executionHostId === target.executionHostId)
  )
  if (!error) {
    return null
  }
  return {
    worktreeId: target.worktreeId,
    ...(target.executionHostId ? { executionHostId: target.executionHostId } : {}),
    displayName: target.displayName,
    message: error.executionHostId
      ? translate(
          'auto.store.slices.workspace.cleanup.gitStatusUnavailable',
          "Orca couldn't check this workspace's git status. Try again, or delete it from its host-specific sidebar or project list."
        )
      : translate(
          'auto.store.slices.workspace.cleanup.gitStatusUnavailableOlderPeer',
          "Orca couldn't match this git-status failure to a host. Update the older connected peer, or delete the workspace from its host-specific sidebar or project list."
        ),
    canDeleteAnyway: true
  }
}

export function getWorkspaceCleanupGitUnavailableFailure(
  target: PreflightFailureTarget,
  candidate: WorkspaceCleanupCandidate
): WorkspaceCleanupFailure {
  return {
    worktreeId: target.worktreeId,
    ...(target.executionHostId ? { executionHostId: target.executionHostId } : {}),
    displayName: candidate.displayName,
    message: translate(
      'auto.store.slices.workspace.cleanup.gitStatusUnavailable',
      "Orca couldn't check this workspace's git status. Try again, or delete it from its host-specific sidebar or project list."
    ),
    canDeleteAnyway: true
  }
}

// Unlike unknown-base and git-status-error, these facts prove known work is at risk.
const WORKSPACE_CLEANUP_CONCRETE_RISK_BLOCKERS = ['dirty-files', 'unpushed-commits'] as const

// Kept apart from the risk blockers above on purpose: these two are positive
// evidence that work is live, while `terminal-liveness-unknown` is the loss of
// contact that proves nothing either way. Both invalidate a confirmation, but
// only these may be reported to the user as running.
const WORKSPACE_CLEANUP_LIVE_WORK_BLOCKERS = ['running-terminal', 'live-agent'] as const
