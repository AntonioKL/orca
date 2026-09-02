import type { SpawnedProcess } from '../../shared/child-process/run-process'
import { killCodexAppServerProcessTree } from '../codex/codex-app-server-session'
import { waitForProcessExitUntil } from '../codex/codex-process-exit-deadline'

const GRACEFUL_EXIT_MS = 1_500
const FORCED_EXIT_MS = 1_000

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
  killTree?: (child: Pick<SpawnedProcess, 'pid' | 'kill'>) => void
}): Promise<boolean> {
  try {
    input.child.stdin?.end()
  } catch {
    // The reap below still owns the process.
  }
  if (!input.exited()) {
    await waitForProcessExitUntil(input.exitPromise, GRACEFUL_EXIT_MS)
    if (!input.exited()) {
      ;(input.killTree ?? killCodexAppServerProcessTree)(input.child)
      await waitForProcessExitUntil(input.exitPromise, FORCED_EXIT_MS)
    }
  }
  return input.exited()
}
