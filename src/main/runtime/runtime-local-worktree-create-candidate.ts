import type { Repo } from '../../shared/repo-types'
import type { getPRForBranch } from '../github/client'
import type { getWorktreePathSettings } from '../ipc/worktree-logic'
import {
  computeWorktreePath,
  ensurePathWithinWorkspace,
  sanitizeWorktreeName
} from '../ipc/worktree-logic'
import { getBranchConflictKind } from '../git/repo'
import {
  getBranchNameOverrideCandidate,
  getWorktreeCreateCandidate,
  WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS
} from '../worktree-create-candidates'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import {
  getSelectedReviewBranch,
  isAllowedPushTargetRemoteConflict,
  isMatchingSelectedGitHubPr
} from './selected-review-branch'
import {
  canCheckoutExistingLocalBranch,
  getLocalGitHubPrForBranch,
  getSelectedHostedReviewForBranch,
  resolveCreateBranchName
} from './runtime-worktree-create-git'
import { runtimePathExists } from './runtime-worktree-filesystem'

export type RuntimeLocalWorktreeCreateCandidate = {
  effectiveRequestedName: string
  requestedDisplayName?: string
  effectiveSanitizedName: string
  branchName: string
  checkoutExistingBranch: boolean
  worktreePath: string
}

export async function resolveRuntimeLocalWorktreeCreateCandidate(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: Repo
  settings: ReturnType<typeof getWorktreePathSettings> & {
    branchPrefix: string
    branchPrefixCustom?: string
  }
  worktreePathSettings: ReturnType<typeof getWorktreePathSettings>
  workspaceRoot: string
  username: string
  baseBranch: string
  localWorktreeGitOptions: { wslDistro?: string }
  localWorktreeGitOptionArgs: [] | [{ wslDistro?: string }]
  hostedReviewExecutionContext?: { localGitExecOptions: { wslDistro?: string } }
}): Promise<RuntimeLocalWorktreeCreateCandidate> {
  const sanitizedName = sanitizeWorktreeName(args.request.name)
  let effectiveRequestedName = args.request.name
  let effectiveSanitizedName = sanitizedName
  let branchName = ''
  let checkoutExistingBranch = false
  let selectedExistingLocalBranchName: string | null = null
  let branchConflictKind: 'local' | 'remote' | null = null
  let worktreePath = ''
  let worktreePathResolved = false
  for (let suffix = 1; suffix <= WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS; suffix += 1) {
    effectiveSanitizedName = getWorktreeCreateCandidate(sanitizedName, suffix)
    effectiveRequestedName = args.request.name.trim()
      ? getWorktreeCreateCandidate(args.request.name, suffix)
      : effectiveSanitizedName
    branchName = await resolveCreateBranchName(
      args.repo.path,
      selectedExistingLocalBranchName ??
        getBranchNameOverrideCandidate(args.request.branchNameOverride, suffix),
      effectiveSanitizedName,
      args.settings,
      args.username,
      args.localWorktreeGitOptions
    )
    checkoutExistingBranch = await canCheckoutExistingLocalBranch(
      args.repo.path,
      branchName,
      args.baseBranch,
      ...args.localWorktreeGitOptionArgs
    )
    if (checkoutExistingBranch && !selectedExistingLocalBranchName) {
      selectedExistingLocalBranchName = branchName
    }
    branchConflictKind = checkoutExistingBranch
      ? null
      : await getBranchConflictKind(
          args.repo.path,
          branchName,
          args.baseBranch,
          ...args.localWorktreeGitOptionArgs
        )
    const allowedPushTargetRemoteConflict =
      branchConflictKind &&
      isAllowedPushTargetRemoteConflict(branchConflictKind, branchName, args.request)
    let selectedReviewConflictMatched = false
    if (branchConflictKind) {
      if (allowedPushTargetRemoteConflict) {
        let existingPR: Awaited<ReturnType<typeof getPRForBranch>> | null = null
        const selectedReview = getSelectedReviewBranch(args.request)
        if (selectedReview?.provider === 'github') {
          try {
            existingPR = await getLocalGitHubPrForBranch(
              args.repo.path,
              branchName,
              args.localWorktreeGitOptions
            )
          } catch {}
          if (isMatchingSelectedGitHubPr(existingPR, args.request, branchName)) {
            branchConflictKind = null
            selectedReviewConflictMatched = true
          }
        } else if (selectedReview) {
          const review = await getSelectedHostedReviewForBranch(
            args.repo,
            branchName,
            args.request,
            args.hostedReviewExecutionContext
          ).catch(() => null)
          if (review?.matchesSelected) {
            branchConflictKind = null
            selectedReviewConflictMatched = true
          }
        }
      }
      if (branchConflictKind) {
        continue
      }
    }
    if (!checkoutExistingBranch && !selectedReviewConflictMatched) {
      let existingPR: Awaited<ReturnType<typeof getPRForBranch>> | null = null
      try {
        existingPR = await getLocalGitHubPrForBranch(
          args.repo.path,
          branchName,
          args.localWorktreeGitOptions
        )
      } catch {}
      if (existingPR && !isMatchingSelectedGitHubPr(existingPR, args.request, branchName)) {
        continue
      }
    }
    worktreePath = ensurePathWithinWorkspace(
      computeWorktreePath(effectiveSanitizedName, args.repo.path, args.worktreePathSettings),
      args.workspaceRoot
    )
    if (!(await runtimePathExists(worktreePath))) {
      worktreePathResolved = true
      break
    }
  }
  if (!worktreePathResolved) {
    if (branchConflictKind) {
      throw new Error(
        `Branch "${branchName}" already exists ${branchConflictKind === 'local' ? 'locally' : 'on a remote'}.`
      )
    }
    throw new Error(
      `Could not find an available worktree path for "${sanitizedName}". Pick a different worktree name.`
    )
  }
  return {
    effectiveRequestedName,
    requestedDisplayName: args.request.displayName?.trim() || undefined,
    effectiveSanitizedName,
    branchName,
    checkoutExistingBranch,
    worktreePath
  }
}
