import type { SpawnedProcess } from '../../shared/child-process/run-process'
import { waitForProcessExitUntil } from '../codex/codex-process-exit-deadline'
import { terminateDescendantSnapshotAndWait } from '../pty-descendant-exit-verification'
import { captureDescendantSnapshot, type DescendantSnapshot } from '../pty-descendant-termination'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'

const GRACEFUL_EXIT_MS = 1_500
const FORCED_EXIT_MS = 1_000

type ReapableChild = Pick<SpawnedProcess, 'pid' | 'kill'>

export type ClaudeChildTreeReaperDeps = {
  platform?: NodeJS.Platform
  captureDescendants?: (rootPid: number) => Promise<DescendantSnapshot | null>
  terminateDescendants?: (snapshot: DescendantSnapshot) => Promise<boolean>
  terminateWindowsTree?: (rootPid: number) => Promise<void>
}

export type ClaudeChildTreeReaper = {
  /**
   * Kill the child's whole tree. Resolves true only once every snapshotted
   * descendant is verified gone within the bounded deadline; false is unproven.
   * Concurrent calls share one reap, and a later call re-verifies the same
   * snapshot rather than trusting a root that has since died on its own.
   */
  reap(): Promise<boolean>
  /** Null until a reap has run. False marks a tree the close proof may not vouch for. */
  readonly treeExited: boolean | null
}

/**
 * The same shared primitives the Codex structured provider composes: a raw
 * pipe child owns no PTY job, so there is nothing for the PTY job sweep to
 * terminate on Windows and no unref'd timer is allowed to outlive the proof.
 */
export function createClaudeChildTreeReaper(
  child: ReapableChild,
  deps: ClaudeChildTreeReaperDeps = {}
): ClaudeChildTreeReaper {
  const platform = deps.platform ?? process.platform
  // Undefined until the root has been snapshotted; null when the table could not
  // be read while the root was alive, which no later read can make up for.
  let snapshot: DescendantSnapshot | null | undefined
  let inFlight: Promise<boolean> | null = null
  let treeExited: boolean | null = null

  async function reapOnce(): Promise<boolean> {
    const rootPid = child.pid
    if (!rootPid) {
      // Never spawned, so there is no tree to have orphaned.
      return true
    }
    if (platform === 'win32') {
      await (deps.terminateWindowsTree ?? terminateWindowsProcessTree)(rootPid)
      // taskkill owns the tree; this preserves the direct-child fallback when it fails.
      child.kill('SIGKILL')
      return true
    }
    if (snapshot === undefined) {
      snapshot = await (deps.captureDescendants ?? captureDescendantSnapshot)(rootPid).catch(
        () => null
      )
    }
    if (!snapshot) {
      child.kill('SIGKILL')
      return false
    }
    // Why the root is killed while verification is already running, and never
    // SIGSTOPped first the way the Codex non-group path does: measured on macOS, a
    // killed child of a stopped parent stays a zombie row in ps with its lstart
    // and pgid intact, so verification cannot pass until the root is dead. The
    // descendants are signalled in the verifier's synchronous prefix, while their
    // parent links are still real; the root's death then reparents any zombies
    // to init, which reaps them.
    const verified = (deps.terminateDescendants ?? terminateDescendantSnapshotAndWait)(snapshot)
    child.kill('SIGKILL')
    return verified
  }

  return {
    reap() {
      if (inFlight) {
        return inFlight
      }
      const attempt = reapOnce()
        .catch(() => false)
        .then((exited) => {
          treeExited = exited
          return exited
        })
      inFlight = attempt
      void attempt.finally(() => {
        if (inFlight === attempt) {
          inFlight = null
        }
      })
      return attempt
    },
    get treeExited() {
      return treeExited
    }
  }
}

/**
 * Orca's own shutdown ladder on the child it spawned, kept because the SDK's
 * close path returns no proof and Orca never releases a lease on an assumed exit.
 *
 * Resolves true only after the child actually emitted exit and no reap has left
 * its descendants unproven; false is unproven.
 */
export async function proveClaudeChildExit(input: {
  child: Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin'>
  exitPromise: Promise<void>
  exited: () => boolean
  tree?: ClaudeChildTreeReaper
}): Promise<boolean> {
  const tree = input.tree ?? createClaudeChildTreeReaper(input.child)
  try {
    input.child.stdin?.end()
  } catch {
    // The reap below still owns the process.
  }
  if (!input.exited()) {
    await waitForProcessExitUntil(input.exitPromise, GRACEFUL_EXIT_MS)
    if (!input.exited()) {
      await tree.reap()
      await waitForProcessExitUntil(input.exitPromise, FORCED_EXIT_MS)
    }
  }
  if (tree.treeExited === false) {
    // A retried close re-verifies the retained snapshot: the root's own exit is
    // not evidence that the descendants it left behind are gone.
    await tree.reap()
  }
  return input.exited() && tree.treeExited !== false
}
