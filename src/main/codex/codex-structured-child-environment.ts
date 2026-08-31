import type { CodexStructuredLaunch } from './codex-structured-session-state'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'
import { addWslEnvKeys } from '../../shared/wsl-env'

export function buildCodexStructuredChildEnvironment(
  launch: CodexStructuredLaunch,
  spawnToken: string
): Record<string, string> {
  const env: Record<string, string> = {
    ...launch.env,
    ...(launch.codexHome ? { CODEX_HOME: launch.codexHome } : {}),
    [CODEX_SPAWN_TOKEN_ENV]: spawnToken
  }
  if (/^wsl(?:\.exe)?$/i.test(launch.command) || /[\\/]wsl\.exe$/i.test(launch.command)) {
    addWslEnvKeys(env, [CODEX_SPAWN_TOKEN_ENV])
  }
  return env
}
