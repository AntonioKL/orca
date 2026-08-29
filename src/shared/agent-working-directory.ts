import { hasUnsafeProviderSessionIdChars } from './agent-session-resume'

const AGENT_WORKING_DIRECTORY_MAX_LENGTH = 4096

/** POSIX root, Windows drive root, or UNC share. A relative path is meaningless
 *  without the process that emitted it, so it can only read as unknown. */
function isAbsoluteAgentWorkingDirectory(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/** The directory the agent process itself reports it is rooted in, on the host that
 *  runs it. Never resolved against the local filesystem — an SSH/WSL agent reports a
 *  path that only exists on its own execution host. Absent means unknown, which is
 *  NOT the same as the pane's worktree (STA-5804). */
export function normalizeAgentWorkingDirectory(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const trimmed = raw.trim()
  if (
    trimmed.length === 0 ||
    trimmed.length > AGENT_WORKING_DIRECTORY_MAX_LENGTH ||
    hasUnsafeProviderSessionIdChars(trimmed) ||
    !isAbsoluteAgentWorkingDirectory(trimmed)
  ) {
    return undefined
  }
  return trimmed
}

/** Read the agent's own working directory off a raw hook payload. Claude and Codex
 *  report `cwd`; other providers spell it `workspaceRoot`/`workspace_root`. */
export function extractAgentWorkingDirectory(payload: Record<string, unknown>): string | undefined {
  for (const key of ['cwd', 'workspaceRoot', 'workspace_root'] as const) {
    const normalized = normalizeAgentWorkingDirectory(payload[key])
    if (normalized) {
      return normalized
    }
  }
  return undefined
}
