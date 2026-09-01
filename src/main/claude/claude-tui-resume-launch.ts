import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { resolveClaudeCommand } from '../codex-cli/command'
import { getSpawnArgsForWindows } from '../win32-utils'
import { buildClaudeChildProcessEnv } from './claude-child-process-environment'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import { CLAUDE_DEFAULT_SETTING_SOURCES } from './claude-structured-launch-resolution'
import { CLAUDE_SPAWN_TOKEN_ENV } from './claude-structured-owner-identity'

export const CLAUDE_TUI_RESUME_BASE_ARGS = [
  '--setting-sources',
  CLAUDE_DEFAULT_SETTING_SOURCES.join(',')
] as const

export type ClaudeTuiResumeLaunch = {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  providerSessionId: string
  resumeLeafUuid: string | null
}

export type ClaudeTuiResumeLaunchBuilderDeps = {
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveCommand?: () => string
  resolveEnv?: () => Record<string, string>
  inheritedEnv?: NodeJS.ProcessEnv
}

export function createClaudeTuiResumeLaunchBuilder(
  deps: ClaudeTuiResumeLaunchBuilderDeps
): (input: { record: AgentSessionRecord; spawnToken: string }) => Promise<ClaudeTuiResumeLaunch> {
  return async ({ record, spawnToken }) => {
    if (record.provider !== 'claude') {
      throw new Error(`session ${record.sessionId} is a ${record.provider} session`)
    }
    if (record.accountHome.variable !== 'CLAUDE_CONFIG_DIR') {
      throw new Error(`claude sessions pin CLAUDE_CONFIG_DIR, not ${record.accountHome.variable}`)
    }
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    if (head?.handle.provider !== 'claude') {
      throw new Error('claude_tui_resume_handle_required')
    }

    const command = (deps.resolveCommand ?? resolveClaudeCommand)()
    const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, [
      ...(record.launchArgs ?? []),
      ...CLAUDE_TUI_RESUME_BASE_ARGS,
      '--resume',
      head.handle.sessionId
    ])
    const configuredEnv = deps.resolveEnv?.() ?? {}
    // Compared against what the child would otherwise inherit, so the record's account
    // home still wins over a diverging overlay without a needless pin.
    const inheritedEnv = { ...(deps.inheritedEnv ?? process.env), ...configuredEnv }
    const env = buildClaudeChildProcessEnv(
      {
        ...configuredEnv,
        ...claudeConfigDirEnvPatch(record.accountHome.path, { env: inheritedEnv }),
        ORCA_AGENT_LAUNCH_TOKEN: spawnToken,
        [CLAUDE_SPAWN_TOKEN_ENV]: spawnToken
      },
      { inheritedEnv: deps.inheritedEnv }
    )
    const pairedEnv = withCliRuntimeOnPath(command, env, { platform: process.platform })

    return {
      command: spawnCmd,
      args: spawnArgs,
      cwd: await deps.resolveWorkspacePath(record.location.workspaceId),
      env: pairedEnv,
      providerSessionId: head.handle.sessionId,
      resumeLeafUuid: head.handle.leafUuid
    }
  }
}
