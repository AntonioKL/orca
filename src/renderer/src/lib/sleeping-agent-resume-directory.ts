import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'

/** Where a resumed provider session should be rooted.
 *
 *  `unknown` is a verdict, not a missing value: the record never carried the agent's own
 *  working directory (written before STA-5804, or the provider's hook reports none). The
 *  pane's worktree is NOT an answer to it — an agent the user started by hand from a
 *  subdirectory is filed under the worktree while its transcript lives elsewhere, so
 *  resuming at the worktree reopens the conversation somewhere it was never about. */
export type SleepingAgentResumeDirectory =
  | { kind: 'agent-reported'; cwd: string }
  | { kind: 'unknown' }

export function resolveSleepingAgentResumeDirectory(
  record: Pick<SleepingAgentSessionRecord, 'agentCwd'>
): SleepingAgentResumeDirectory {
  const cwd = record.agentCwd?.trim()
  // Not resolved against the local filesystem: on an SSH or WSL worktree this path only
  // exists on the execution host, which validates it when the PTY spawns.
  return cwd ? { kind: 'agent-reported', cwd } : { kind: 'unknown' }
}
