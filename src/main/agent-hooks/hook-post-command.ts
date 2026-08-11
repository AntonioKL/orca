import type { AgentHookSource } from '../../shared/agent-hook-relay'

export function buildPosixAgentHookJsonPostCommand(
  source: AgentHookSource,
  options: { curlCommand?: string; indent?: string } = {}
): string[] {
  const curlCommand = options.curlCommand ?? 'curl'
  const indent = options.indent ?? '  '
  const encodeHeader = (name: string): string => `$(printf '%s' "$${name}" | base64 | tr -d '\\n')`
  return [
    `printf '%s' "$payload" | ${curlCommand} -sS -X POST "http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}/hook/${source}" \\`,
    `${indent}--connect-timeout "\${connect_timeout:-0.5}" --max-time "\${max_time:-1.5}" \\`,
    `${indent}--noproxy "127.0.0.1" \\`,
    `${indent}-H "Content-Type: application/json" \\`,
    `${indent}-H "X-Orca-Agent-Hook-Token: \${ORCA_AGENT_HOOK_TOKEN}" \\`,
    `${indent}-H "X-Orca-Agent-Hook-Meta-Encoding: base64" \\`,
    `${indent}-H "X-Orca-Pane-Key: ${encodeHeader('ORCA_PANE_KEY')}" \\`,
    `${indent}-H "X-Orca-Tab-Id: ${encodeHeader('ORCA_TAB_ID')}" \\`,
    `${indent}-H "X-Orca-Launch-Token: ${encodeHeader('ORCA_AGENT_LAUNCH_TOKEN')}" \\`,
    `${indent}-H "X-Orca-Worktree-Id: ${encodeHeader('ORCA_WORKTREE_ID')}" \\`,
    `${indent}-H "X-Orca-Agent-Hook-Env: ${encodeHeader('ORCA_AGENT_HOOK_ENV')}" \\`,
    `${indent}-H "X-Orca-Agent-Hook-Version: ${encodeHeader('ORCA_AGENT_HOOK_VERSION')}" \\`,
    `${indent}--data-binary @-`
  ]
}
