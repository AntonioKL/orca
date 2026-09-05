import { mkdir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { isFolderRepo } from '../shared/repo-kind'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import type { PreparedCheckoutMissReason } from '../shared/worktree/create-types'
import type { AddWorktreeOptions, AddWorktreeResult } from './git/worktree'
import { measureRetargetDivergence } from './git/worktree-base-divergence'
import { resolveLocalWorktreeBaseRef } from './git/worktree-base-ref-probe'
import {
  preparationEntryKey,
  preparationPathKey,
  selectPreparationForCreate
} from './worktree-create-preparation-claim'
import {
  _resetPreparationPoolForTests,
  findPreparation,
  hasPendingPreparations,
  listPreparations,
  startPreparation,
  takePreparation,
  type PreparationEntry,
  type StartPreparationArgs
} from './worktree-create-preparation-pool'
import {
  discardPreparedWorktree,
  finalizePreparedWorktree
} from './git/worktree-create-preparation'
import {
  getLocalProjectWorktreeGitOptions,
  getWorktreeMirrorDistro
} from './project-runtime-git-options'
import { computeWorkspaceRootAsync, getWorktreePathSettings } from './ipc/worktree-logic'
import {
  recordPreparationCreate,
  resetPreparationCreateHistoryForTests
} from './worktree-create-preparation-burst'
import { toHostFilesystemPath } from './host-tree-removal'
import type { WorktreeCreateTimingRecorder } from './worktree-create-timing'

export {
  WORKTREE_CREATE_PREPARATION_LIMIT,
  WORKTREE_CREATE_PREPARATION_TTL_MS
} from './worktree-create-preparation-pool'

/** A prepared checkout is a create that is either in flight or imminent. */
export function hasPendingWorktreeCreatePreparations(): boolean {
  return hasPendingPreparations()
}

export type PreparedWorktreeCreateAttempt =
  | { status: 'hit'; retargeted: boolean; result: AddWorktreeResult }
  | { status: 'miss'; reason: PreparedCheckoutMissReason }

type ConsumePreparedWorktreeArgs = {
  repoPath: string
  workspaceRoot: string
  worktreePath: string
  branch: string
  baseBranch: string
  refreshLocalBaseRef?: boolean
  options?: AddWorktreeOptions
  timing?: WorktreeCreateTimingRecorder
}

function canonicalBaseRef(
  repoPath: string,
  baseBranch: string,
  options: AddWorktreeOptions
): Promise<string> {
  return resolveLocalWorktreeBaseRef(
    repoPath,
    baseBranch,
    options.wslDistro ? { wslDistro: options.wslDistro } : {}
  )
}

export async function prepareWorktreeCreateForRepo(
  store: Store,
  repo: Repo,
  baseBranch: string
): Promise<void> {
  if (repo.connectionId || isFolderRepo(repo)) {
    return
  }
  const options = getLocalProjectWorktreeGitOptions(store, repo)
  // Resolving a WSL repo's root spawns `wsl.exe`, and this runs while the create composer is open,
  // so it must not block the main thread. Key lookup and insert stay in one sync run after the await.
  // The mirror distro must be threaded exactly as createLocalWorktree threads it, or the two sides
  // key on different roots and every prepared checkout is discarded.
  const workspaceRoot = await computeWorkspaceRootAsync(
    repo.path,
    getWorktreePathSettings(repo, store.getSettings(), getWorktreeMirrorDistro(store, repo))
  )
  const canonicalBase = await canonicalBaseRef(repo.path, baseBranch, options)
  const existing = findPreparation(
    preparationPathKey(repo.path),
    preparationPathKey(workspaceRoot),
    canonicalBase,
    options.wslDistro ?? ''
  )
  if (existing) {
    return existing.ready
  }

  return startPreparation({
    repoPath: repo.path,
    workspaceRoot,
    baseBranch,
    canonicalBase,
    options
  })
}

type ClaimedPreparation =
  | { status: 'claimed'; entry: PreparationEntry; retargeted: boolean; canonicalBase: string }
  | { status: 'miss'; reason: PreparedCheckoutMissReason }

async function claimPreparedWorktree(
  args: ConsumePreparedWorktreeArgs,
  options: AddWorktreeOptions
): Promise<ClaimedPreparation> {
  const request = {
    repoPathKey: preparationPathKey(args.repoPath),
    workspaceRootKey: preparationPathKey(args.workspaceRoot),
    wslDistro: options.wslDistro ?? '',
    baseBranch: args.baseBranch
  }
  let selection = selectPreparationForCreate(listPreparations(), {
    ...request,
    canonicalBase: null
  })
  if (selection.kind === 'needs-canonical-base') {
    // The probe is the only await here, and the pool is re-read after it, so the select-and-take
    // below stays one synchronous run and no other create can hold the same entry.
    const canonicalBase = await canonicalBaseRef(args.repoPath, args.baseBranch, options)
    selection = selectPreparationForCreate(listPreparations(), { ...request, canonicalBase })
  }
  if (selection.kind !== 'exact' && selection.kind !== 'retarget') {
    return {
      status: 'miss',
      reason: selection.kind === 'miss' ? selection.reason : 'base_mismatch'
    }
  }
  if (selection.kind === 'retarget') {
    const candidate = selection.candidate
    const { canonicalBase } = selection
    const divergence = await measureRetargetDivergence(
      args.repoPath,
      candidate.canonicalBase,
      canonicalBase,
      {
        ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
        // Why forward it: a cancelled create must stop these probes now, not at the deadline.
        ...(options.signal ? { signal: options.signal } : {})
      }
    )
    if (divergence !== 'within') {
      return {
        status: 'miss',
        reason: divergence === 'exceeded' ? 'retarget_too_divergent' : 'retarget_unverifiable'
      }
    }
    // Re-select after the walk: the pool may have gained an exact match or lost this entry. A
    // different retarget candidate is left for the next create rather than claimed unverified.
    selection = selectPreparationForCreate(listPreparations(), { ...request, canonicalBase })
    if (selection.kind === 'miss' || selection.kind === 'needs-canonical-base') {
      return { status: 'miss', reason: 'base_mismatch' }
    }
    if (selection.kind === 'retarget' && selection.candidate !== candidate) {
      return { status: 'miss', reason: 'base_mismatch' }
    }
  }
  const entry = selection.candidate
  const warmingStopped = takePreparation(entry)
  try {
    const waitUntilClaimable = async () => {
      await entry.ready
      if (!(await warmingStopped)) {
        throw new Error('prepared index warming termination unverifiable')
      }
    }
    await (args.timing
      ? args.timing.time('prepared_checkout_wait', waitUntilClaimable)
      : waitUntilClaimable())
    return {
      status: 'claimed',
      entry,
      retargeted: selection.kind === 'retarget',
      canonicalBase: selection.canonicalBase
    }
  } catch {
    return { status: 'miss', reason: 'prepare_failed' }
  }
}

/** Re-arm only for repeated creates; an unused full checkout still has the pool's cap and TTL. */
function rearmPreparation(args: StartPreparationArgs): void {
  const repoPathKey = preparationPathKey(args.repoPath)
  const workspaceRootKey = preparationPathKey(args.workspaceRoot)
  const wslDistro = args.options.wslDistro ?? ''
  const key = preparationEntryKey(repoPathKey, workspaceRootKey, args.canonicalBase, wslDistro)
  // Count the create even when a concurrent prefetch already supplied its replacement.
  const continuesBurst = recordPreparationCreate(key)
  if (
    !continuesBurst ||
    findPreparation(repoPathKey, workspaceRootKey, args.canonicalBase, wslDistro)
  ) {
    return
  }
  void startPreparation(args).catch(() => {
    // A warm-up failure is recovered by the normal add on the next create.
  })
}

/** Called in the background only after a successful cold create eligible for preparation. */
export async function recordUnpreparedWorktreeCreate(
  args: Omit<StartPreparationArgs, 'canonicalBase'>
): Promise<void> {
  // A completed request's cancellation and timeout must not govern its speculative replacement.
  const options = args.options.wslDistro ? { wslDistro: args.options.wslDistro } : {}
  const canonicalBase = await canonicalBaseRef(args.repoPath, args.baseBranch, options)
  rearmPreparation({ ...args, canonicalBase, options })
}

export async function consumePreparedWorktreeCreate(
  args: ConsumePreparedWorktreeArgs
): Promise<PreparedWorktreeCreateAttempt> {
  const options = args.options ?? {}
  const claim = await claimPreparedWorktree(args, options)
  if (claim.status === 'miss') {
    return { status: 'miss', reason: claim.reason }
  }
  const { entry } = claim
  try {
    const parentDir = isWindowsAbsolutePathLike(args.worktreePath)
      ? win32.dirname(args.worktreePath)
      : posix.dirname(args.worktreePath)
    await mkdir(toHostFilesystemPath(parentDir), { recursive: true })
    // Finalize resolves the requested base itself and resets the prepared checkout onto that
    // commit, so a retargeted claim is handed over at the requested commit or not at all.
    const finalize = () =>
      finalizePreparedWorktree(
        args.repoPath,
        entry.preparedPath,
        args.worktreePath,
        args.branch,
        args.baseBranch,
        args.refreshLocalBaseRef,
        options
      )
    const result = args.timing
      ? await args.timing.time('prepared_checkout_finalize', finalize)
      : await finalize()
    // Consuming the only prepared checkout leaves the next create cold. Re-arm for a user who is
    // creating in a burst; the TTL and the preparation limit still bound an unused replacement.
    rearmPreparation({
      repoPath: entry.repoPath,
      workspaceRoot: entry.workspaceRoot,
      baseBranch: args.baseBranch,
      canonicalBase: claim.canonicalBase,
      options: entry.options
    })
    return { status: 'hit', retargeted: claim.retargeted, result }
  } catch (error) {
    await discardPreparedWorktree(args.repoPath, entry.preparedPath, options).catch(() => {})
    console.warn(
      '[worktree-create] prepared checkout could not be finalized; using normal add',
      error
    )
    return { status: 'miss', reason: 'finalize_failed' }
  }
}

export async function _resetWorktreeCreatePreparationsForTests(): Promise<void> {
  resetPreparationCreateHistoryForTests()
  await _resetPreparationPoolForTests()
}
