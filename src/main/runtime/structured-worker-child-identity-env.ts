/**
 * The orchestration identity — and the CLI reachability — a structured worker's own child needs
 * to speak for itself.
 *
 * Without `ORCA_TERMINAL_HANDLE` the worker's Bash tool has nothing to pass as `--from`, and
 * `resolveOrchestrationTerminalHandle` falls back to a cwd lookup that returns whichever leaf in
 * the worktree comes first. Two attacks follow from that: a bare `check` reads and consumes a
 * SIBLING's dispatch mailbox, and a bare `send --type worker_done` can settle a sibling's
 * context-only dispatch, a tier that has no capability token to reject on.
 *
 * `ORCA_CLI_COMMAND: 'orca'` is honest ONLY because of the PATH prepend below. Orca's Linux CLI
 * installs as `orca-ide` so it never claims GNOME Orca's /usr/bin/orca (stablyai/orca#7904), and
 * on packaged macOS/Windows the bundled launcher is reachable only from the app's own resources
 * dir. A PTY worker gets that treatment from `buildPtyHostEnv`; a structured worker has no PTY,
 * so it applies the SAME function here rather than a second, drifting copy of the rule.
 *
 * Deliberately NOT `ORCA_PANE_KEY`. Claude structured sessions run hooks, and a pane key in their
 * environment starts flowing into hook-emitted agent-status payloads and the hook-attestation,
 * agent-row and mobile-projection pipelines, every one of which assumes a pane key names a live
 * PTY leaf. It would also open `selectExactWorkerProviderSession`, which is fail-closed today
 * precisely because a structured session emits no hook agent status. The CLI needs none of it once
 * the handle is present.
 *
 * A session that is not a dispatched worker is handed back its own env untouched, so an ordinary
 * chat session's child is unchanged. The handle is read from the registry at spawn time, so an
 * in-host recovery respawn re-bakes the SAME handle rather than a stale or fresh one.
 */

import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { prependOrcaCliDirToChildPath } from '../cli/orca-cli-child-path'
import { structuredWorkerIdentities } from './structured-worker-identity'

export function structuredWorkerChildIdentityEnv(
  sessionId: string,
  childEnv: Record<string, string>
): Record<string, string> {
  const identity = structuredWorkerIdentities.getBySessionId(sessionId)
  if (!identity) {
    return childEnv
  }
  const env: Record<string, string> = {
    ...childEnv,
    ORCA_TERMINAL_HANDLE: identity.handle,
    ORCA_CLI_COMMAND: 'orca'
  }
  applyOrcaCliPath(env)
  return env
}

/**
 * A host with no app environment installed — a plain-Node fork, or a unit test — has no userData
 * root to resolve, and inventing one would write a shim into the wrong directory.
 */
function applyOrcaCliPath(env: Record<string, string>): void {
  if (!hasAppEnvironment()) {
    return
  }
  const app = getAppEnvironment()
  prependOrcaCliDirToChildPath(env, {
    isPackaged: app.isPackaged(),
    userDataPath: app.getPath('userData'),
    resourcesPath: process.resourcesPath ?? null
  })
}
