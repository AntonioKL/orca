import {
  classifyGitObjectStoreFailure,
  formatGitObjectStoreFailureMessage,
  isGitObjectStoreFailureMessage
} from '../../shared/git-object-store-failure'
import { extractExecError } from './exec-error'
import { diagnoseWorktreeObjectStore } from './worktree-object-store-diagnosis'

type GitRunner = (args: string[]) => Promise<{ stdout: string }>

export type WorktreeAddObjectStoreContext = {
  /** Runs git in the repo that owns the object store; SSH passes the relay executor. */
  runGit: GitRunner
  /** Branch the user asked for, shown back to them. */
  branch: string
  /** Rev whose tree the checkout needed: the existing branch, or the resolved base. */
  checkoutRef: string
}

/**
 * Replace a raw `git worktree add` object-store failure with a redacted, diagnosed one.
 *
 * Returns `null` when the error is something else, so callers rethrow unchanged.
 * Shared by the local/WSL and SSH create paths, which duplicate the same preflight
 * and must not diverge on how the failure reads.
 */
export async function describeWorktreeAddObjectStoreFailure(
  error: unknown,
  context: WorktreeAddObjectStoreContext
): Promise<Error | null> {
  const text = extractExecError(error).stderr
  // Why: a diagnosis quotes git's wording back, so re-classifying one would re-probe and
  // nest it. The sparse path can hand us an error already described by `addWorktree`.
  if (isGitObjectStoreFailureMessage(text)) {
    return null
  }
  const failure = classifyGitObjectStoreFailure(text)
  if (!failure) {
    return null
  }

  // Diagnosis must never mask the failure we already proved, so probe errors are swallowed.
  const diagnosis = await diagnoseWorktreeObjectStore(context.runGit, context.checkoutRef).catch(
    () =>
      ({
        commit: 'unverifiable',
        rootTree: 'unverifiable',
        partialClone: 'unverifiable'
      }) as const
  )

  const described = new Error(
    formatGitObjectStoreFailureMessage({
      failure,
      branch: context.branch,
      commit: diagnosis.commit,
      rootTree: diagnosis.rootTree,
      partialClone: diagnosis.partialClone
    })
  )
  // Why keep the original: main-process logs and telemetry still want the raw argv; only
  // the message crossing IPC to the renderer is redacted.
  described.cause = error
  return described
}
