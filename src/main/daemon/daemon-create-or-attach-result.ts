import type { TuiAgent } from '../../shared/tui-agent'
import type { ShellReadyState, TerminalSnapshot } from './types'
import type { AgentSessionClaimedSpawnResult } from '../../shared/agent-session-host-authority'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { DeferredStartupStatus } from '../../shared/deferred-startup-release'

export type DaemonCreateOrAttachResult = {
  deferredStartupStatus?: DeferredStartupStatus
  isNew: boolean
  snapshot: TerminalSnapshot | null
  pid: number | null
  shellState: ShellReadyState
  historySeeded?: boolean
  launchAgent?: TuiAgent
  /** Undefined only when talking to a daemon predating WSL session context. */
  wslDistro?: string | null
  agentSessionEnsure?: AgentSessionClaimedSpawnResult
  incarnationId?: PtyIncarnationId
  /**
   * Whether the daemon process itself could read the requested cwd at spawn. Only the daemon's own
   * verdict counts: macOS TCC scopes folder access per process tree, so the app's view of the same
   * path proves nothing about the daemon's (#17696). Omitted by daemons predating this field.
   */
  cwdReadableByDaemon?: boolean
}

export function getDaemonStartupResultMetadata(result: DaemonCreateOrAttachResult): {
  incarnationId?: PtyIncarnationId
  deferredStartupStatus?: DeferredStartupStatus
} {
  return {
    ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
    ...(result.deferredStartupStatus ? { deferredStartupStatus: result.deferredStartupStatus } : {})
  }
}

export function getDaemonSessionResultMetadata(session: {
  launchAgent: TuiAgent | null
  historySeeded: boolean | undefined
  wslDistro: string | null
  deferredStartupStatus?: DeferredStartupStatus
}): {
  deferredStartupStatus?: DeferredStartupStatus
  launchAgent?: TuiAgent
  historySeeded?: boolean
  wslDistro: string | null
} {
  return {
    ...(session.deferredStartupStatus
      ? { deferredStartupStatus: session.deferredStartupStatus }
      : {}),
    ...(session.launchAgent ? { launchAgent: session.launchAgent } : {}),
    ...(session.historySeeded !== undefined ? { historySeeded: session.historySeeded } : {}),
    // Why: null authoritatively identifies a native session; omission is
    // reserved for older daemons that predate this wire field.
    wslDistro: session.wslDistro
  }
}
