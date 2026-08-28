import { RuntimeRpcCallError, callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RuntimeTerminalProcessInspection } from './runtime-terminal-inspection'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from './runtime-terminal-stream'

export function isTerminalGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error instanceof RuntimeRpcCallError
      ? error.code
      : error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
  return (
    code === 'no_connected_pty' ||
    code === 'terminal_handle_stale' ||
    code === 'terminal_exited' ||
    code === 'terminal_gone' ||
    message.includes('terminal_handle_stale') ||
    message.includes('terminal_exited') ||
    message.includes('terminal_gone') ||
    message.includes('no_connected_pty')
  )
}

export async function inspectRuntimeTerminalProcess(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string
): Promise<RuntimeTerminalProcessInspection> {
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  if (target.kind !== 'environment' || !terminal) {
    return window.api.pty.inspectProcess(ptyId)
  }

  try {
    const result = await callRuntimeRpc<{ process: RuntimeTerminalProcessInspection }>(
      target,
      'terminal.inspectProcess',
      { terminal },
      { timeoutMs: 15_000 }
    )
    return result.process
  } catch (error) {
    if (isTerminalGoneError(error)) {
      return { foregroundProcess: null, hasChildProcesses: false, unavailable: true }
    }
    throw error
  }
}
