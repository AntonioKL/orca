import {
  isGitSilentNegativeAnswer,
  type GitObjectPresence,
  type PartialCloneVerdict
} from '../../shared/git-object-store-failure'
import { extractExecError } from './exec-error'

/**
 * Failure-path-only diagnosis for a `worktree add` that died reading objects.
 *
 * Why not a preflight: peeling `^{tree}` costs a whole extra git process on every
 * create (measured at ~15 ms on a 2.9 GiB repo, the same as the `^{commit}` peel
 * it would sit next to) and still proves nothing about subtrees or blobs, so it
 * would slow every success for a partial guarantee. Git's own stderr from the
 * failed command is the authority; these probes only add detail after it fails.
 *
 * Git floor: `rev-parse --verify --quiet`, `<rev>^{commit}`, `<rev>^{tree}` and
 * `config --get-regexp` all long predate the 2.25 baseline, so no capability probe is
 * needed; what does need pinning is Git's silent-vs-diagnostic answer, which
 * git-binary-compatibility.test.ts asserts across the real-binary matrix.
 *
 * Executor-injected so the SSH path routes the same argv through the relay.
 */

export type WorktreeObjectStoreDiagnosis = {
  /** Needed to read `rootTree`: an unreadable commit fails the tree peel for its own reason. */
  commit: GitObjectPresence
  rootTree: GitObjectPresence
  partialClone: PartialCloneVerdict
}

type GitRunner = (args: string[]) => Promise<{ stdout: string }>

// An error carrying no status at all (dead SSH transport, killed process) fails the same
// check, so "we could not read it" is never reported as "it is absent".
function gitAnsweredNo(error: unknown): boolean {
  return isGitSilentNegativeAnswer(
    (error as { code?: unknown } | null)?.code,
    extractExecError(error).stderr
  )
}

// Why peel both: `<rev>^{tree}` answers a silent "no" when the TREE is gone *and* when the
// COMMIT is gone (verified on git 2.44 with the commit object deleted: both peels exit 1 with
// empty stderr), so the tree peel alone cannot tell those apart. Only the pair does; callers
// must not read `rootTree` on its own.
async function probePeel(
  runGit: GitRunner,
  rev: string,
  peel: 'commit' | 'tree'
): Promise<GitObjectPresence> {
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', '--quiet', `${rev}^{${peel}}`])
    // A successful `--verify` always prints the oid, so silence on exit 0 is an answer we did not get.
    return stdout.trim().length > 0 ? 'present' : 'unverifiable'
  } catch (error) {
    return gitAnsweredNo(error) ? 'missing' : 'unverifiable'
  }
}

// `--get-regexp` prints `key value` per line, and a valueless key is Git's implicit true.
function configuresPromisor(stdout: string): boolean {
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .some((line) => {
      const value = line.trim().split(/\s+/)[1]
      return value === undefined || /^(?:true|yes|on|1)$/i.test(value)
    })
}

async function probePartialClone(runGit: GitRunner): Promise<PartialCloneVerdict> {
  try {
    // Why promisor and not extensions.partialClone: current Git records the filter on the
    // remote (`remote.<name>.promisor`) and leaves the extension unset on fresh clones.
    const { stdout } = await runGit(['config', '--get-regexp', '^remote\\..*\\.promisor$'])
    // Exit 0 means it matched, so empty output is a runner artifact rather than "no promisor".
    return stdout.trim().length === 0 ? 'unverifiable' : configuresPromisor(stdout) ? 'yes' : 'no'
  } catch (error) {
    return gitAnsweredNo(error) ? 'no' : 'unverifiable'
  }
}

export async function diagnoseWorktreeObjectStore(
  runGit: GitRunner,
  rev: string
): Promise<WorktreeObjectStoreDiagnosis> {
  const [commit, rootTree, partialClone] = await Promise.all([
    probePeel(runGit, rev, 'commit'),
    probePeel(runGit, rev, 'tree'),
    probePartialClone(runGit)
  ])
  return { commit, rootTree, partialClone }
}
