import type { SpawnedProcess } from '../../shared/child-process/run-process'
import { waitForProcessExitUntil } from '../codex/codex-process-exit-deadline'
import {
  terminateDescendantSnapshotWithVerdict,
  type DescendantTreeVerdict
} from '../pty-descendant-exit-verification'
import { captureDescendantSnapshot, type DescendantSnapshot } from '../pty-descendant-termination'
import {
  captureWindowsDescendantSnapshot,
  verifyWindowsDescendantSnapshotExit,
  type WindowsDescendantSnapshot
} from '../windows-descendant-exit-verification'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'

const GRACEFUL_EXIT_MS = 1_500
const FORCED_EXIT_MS = 1_000

type ReapableChild = Pick<SpawnedProcess, 'pid' | 'kill'>

/** One platform's descendant tree, tagged so neither verifier can be handed the other's rows. */
type CapturedTree =
  | { platform: 'posix'; tree: DescendantSnapshot }
  | { platform: 'win32'; tree: WindowsDescendantSnapshot }

/**
 * A walk is only admissible while the root it walked was alive. A POSIX walk
 * that found no root says so with a null pgid; either platform's walk can also
 * have raced the root's death. Both can only have missed descendants that
 * already reparented away, so neither is evidence about the tree.
 */
function admissibleTree(
  captured: DescendantSnapshot | WindowsDescendantSnapshot | null,
  platform: NodeJS.Platform,
  exited: boolean
): CapturedTree | null {
  if (!captured || exited) {
    return null
  }
  if (platform === 'win32') {
    return { platform: 'win32', tree: captured as WindowsDescendantSnapshot }
  }
  const tree = captured as DescendantSnapshot
  return tree.rootPgid === null ? null : { platform: 'posix', tree }
}

export type ClaudeChildTreeReaperDeps = {
  platform?: NodeJS.Platform
  /** Whether the root's exit has been observed; only a live root can be walked. */
  exited?: () => boolean
  captureDescendants?: (rootPid: number) => Promise<DescendantSnapshot | null>
  terminateDescendants?: (snapshot: DescendantSnapshot) => Promise<DescendantTreeVerdict>
  terminateWindowsTree?: (rootPid: number) => Promise<void>
  captureWindowsDescendants?: (rootPid: number) => Promise<WindowsDescendantSnapshot | null>
  terminateWindowsDescendants?: (
    snapshot: WindowsDescendantSnapshot
  ) => Promise<DescendantTreeVerdict>
}

export type ClaudeChildTreeReaper = {
  /**
   * Snapshot the root's live descendants. The moment the root dies they reparent
   * and no table walk can find them again, so this has to run before anything
   * gives the root a reason to leave. Held once; later calls are no-ops.
   */
  capture(): Promise<void>
  /**
   * Kill the child's whole tree and report what the bounded verification
   * observed. Concurrent calls share one reap, and a later call re-verifies the
   * same snapshot rather than trusting a root that has since died on its own.
   */
  reap(): Promise<DescendantTreeVerdict>
  /**
   * `unverifiable` until a reap observes otherwise. `exited` is the only verdict
   * that lets a close release the lease; `live` names a descendant that was seen
   * still running, which no later caller may collapse into "unknown".
   */
  readonly treeVerdict: DescendantTreeVerdict
}

/**
 * The same shared primitives the Codex structured provider composes: a raw
 * pipe child owns no PTY job, so there is nothing for the PTY job sweep to
 * terminate on Windows and no unref'd timer is allowed to outlive the proof.
 *
 * The proof is unproven by default. `treeVerdict` is assigned in exactly one
 * place, from the verdict of `judgeTree`, so a code path that never reaches a
 * verification cannot report the tree gone by omission.
 */
export function createClaudeChildTreeReaper(
  child: ReapableChild,
  deps: ClaudeChildTreeReaperDeps = {}
): ClaudeChildTreeReaper {
  const platform = deps.platform ?? process.platform
  const exited = deps.exited ?? (() => false)
  // Undefined until captured; null when no admissible snapshot exists — the root
  // was already gone, or the table could not be read while it was alive — which
  // no later read can make up for.
  let snapshot: CapturedTree | null | undefined
  let capturing: Promise<void> | null = null
  let inFlight: Promise<DescendantTreeVerdict> | null = null
  let treeVerdict: DescendantTreeVerdict = 'unverifiable'

  function captureOnce(): Promise<void> {
    if (snapshot !== undefined) {
      return Promise.resolve()
    }
    if (capturing) {
      return capturing
    }
    const rootPid = child.pid
    if (!rootPid || exited()) {
      // Only the root's death makes a missing snapshot final: its descendants
      // have reparented, and no later walk can reach them.
      snapshot = exited() ? null : snapshot
      return Promise.resolve()
    }
    const capture =
      platform === 'win32'
        ? (deps.captureWindowsDescendants ?? captureWindowsDescendantSnapshot)
        : (deps.captureDescendants ?? captureDescendantSnapshot)
    capturing = capture(rootPid)
      .catch(() => null)
      .then((captured) => {
        // A walk that found no root, or that raced the root's death, can only
        // have missed descendants that already reparented away. A table that
        // could not be read in time is not an answer at all: while the root
        // still lives the walk is simply retried, rather than latching a failed
        // read as proof that there was nothing to find.
        const tree = admissibleTree(captured, platform, exited())
        snapshot = captured === null && tree === null && !exited() ? undefined : tree
      })
      .finally(() => {
        capturing = null
      })
    return capturing
  }

  /** The only source of a tree verdict: every `exited` here is an observation. */
  async function judgeTree(): Promise<DescendantTreeVerdict> {
    const rootPid = child.pid
    if (!rootPid) {
      // Never spawned, so the OS never created a tree to orphan.
      return 'exited'
    }
    await captureOnce()
    if (platform === 'win32') {
      // Why taskkill's own outcome is never the verdict: it resolves identically
      // on a timeout, an access denial, a recycled root and a real kill.
      if (!exited()) {
        // A dead root's pid can already belong to a stranger, and `/T /F` would
        // take that stranger's whole tree down with it.
        await (deps.terminateWindowsTree ?? terminateWindowsProcessTree)(rootPid).catch(() => {})
      }
      // taskkill owns the tree; this preserves the direct-child fallback when it fails.
      child.kill('SIGKILL')
      return snapshot?.platform === 'win32'
        ? (deps.terminateWindowsDescendants ?? verifyWindowsDescendantSnapshotExit)(snapshot.tree)
        : 'unverifiable'
    }
    if (snapshot?.platform !== 'posix') {
      child.kill('SIGKILL')
      return 'unverifiable'
    }
    if (snapshot.tree.descendants.length === 0) {
      // Read while the root was alive and childless: a later table read has no
      // row it could match, so it would add nothing to this observation.
      child.kill('SIGKILL')
      return 'exited'
    }
    // Why the root is killed while verification is already running, and never
    // SIGSTOPped first the way the Codex non-group path does: measured on macOS, a
    // killed child of a stopped parent stays a zombie row in ps with its lstart
    // and pgid intact, so verification cannot pass until the root is dead. The
    // descendants are signalled in the verifier's synchronous prefix, while their
    // parent links are still real; the root's death then reparents any zombies
    // to init, which reaps them. After a root exit the kill is a no-op: Node
    // drops the handle on exit and never signals a possibly recycled pid.
    const verdict = (deps.terminateDescendants ?? terminateDescendantSnapshotWithVerdict)(
      snapshot.tree
    )
    child.kill('SIGKILL')
    return verdict
  }

  return {
    capture: captureOnce,
    reap() {
      if (inFlight) {
        return inFlight
      }
      const attempt = judgeTree()
        .catch((): DescendantTreeVerdict => 'unverifiable')
        .then((verdict) => {
          // An observed exit is final; anything later can only be a stale re-read.
          treeVerdict = treeVerdict === 'exited' ? 'exited' : verdict
          return verdict
        })
      inFlight = attempt
      void attempt.finally(() => {
        if (inFlight === attempt) {
          inFlight = null
        }
      })
      return attempt
    },
    get treeVerdict() {
      return treeVerdict
    }
  }
}

/**
 * Orca's own shutdown ladder on the child it spawned, kept because the SDK's
 * close path returns no proof and Orca never releases a lease on an assumed exit.
 *
 * Resolves true only after the child actually emitted exit and its snapshotted
 * descendants were observed gone; false is unproven. A root that left on its
 * own before a snapshot could be armed stays unproven: its descendants had
 * already reparented out of reach when the ladder first looked.
 */
export async function proveClaudeChildExit(input: {
  child: Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin'>
  exitPromise: Promise<void>
  exited: () => boolean
  tree?: ClaudeChildTreeReaper
}): Promise<boolean> {
  const tree = input.tree ?? createClaudeChildTreeReaper(input.child, { exited: input.exited })
  // Arm the proof before stdin closes: a healthy root leaves within the graceful
  // window, and only a snapshot taken while it lived can be verified after that.
  await tree.capture()
  try {
    input.child.stdin?.end()
  } catch {
    // The reap below still owns the process.
  }
  let reaped = false
  if (!input.exited()) {
    await waitForProcessExitUntil(input.exitPromise, GRACEFUL_EXIT_MS)
    if (!input.exited()) {
      reaped = true
      await tree.reap()
      await waitForProcessExitUntil(input.exitPromise, FORCED_EXIT_MS)
    }
  }
  if (!reaped && input.exited() && tree.treeVerdict !== 'exited') {
    // The root's own exit, now or on an earlier attempt, is not evidence that the
    // descendants it left behind are gone: verify the armed snapshot.
    await tree.reap()
  }
  return input.exited() && tree.treeVerdict === 'exited'
}
