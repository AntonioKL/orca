import type { SpawnedProcess } from '../../shared/child-process/run-process'
import { waitForProcessExitUntil } from '../codex/codex-process-exit-deadline'
import { killWithDescendantSweep } from '../pty-descendant-termination'

const GRACEFUL_EXIT_MS = 1_500
const FORCED_EXIT_MS = 1_000

/**
 * Reap the Claude child's whole tree.
 *
 * Orca's shared sweep rather than a same-tick `pkill -P <pid>`: on POSIX it
 * snapshots the descendants while their parent link still exists — a killed
 * parent reparents them to pid 1, where a ppid walk can no longer find them —
 * and signals them before the root goes. On Windows it goes through the
 * identity-gated `taskkill /T /F`, which the same-tick shape never had.
 */
export function reapClaudeChildTree(child: Pick<SpawnedProcess, 'pid' | 'kill'>): Promise<void> {
  return killWithDescendantSweep(child.pid ?? 0, () => {
    child.kill('SIGKILL')
  })
}

/**
 * Orca's own shutdown ladder on the child it spawned, kept because the SDK's
 * close path returns no proof and Orca never releases a lease on an assumed exit.
 *
 * Resolves true only after the child actually emitted exit; false is unproven.
 */
export async function proveClaudeChildExit(input: {
  child: Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin'>
  exitPromise: Promise<void>
  exited: () => boolean
  killTree?: (child: Pick<SpawnedProcess, 'pid' | 'kill'>) => void | Promise<void>
}): Promise<boolean> {
  try {
    input.child.stdin?.end()
  } catch {
    // The reap below still owns the process.
  }
  if (!input.exited()) {
    await waitForProcessExitUntil(input.exitPromise, GRACEFUL_EXIT_MS)
    if (!input.exited()) {
      await (input.killTree ?? reapClaudeChildTree)(input.child)
      await waitForProcessExitUntil(input.exitPromise, FORCED_EXIT_MS)
    }
  }
  return input.exited()
}
