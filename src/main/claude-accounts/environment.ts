export const CLAUDE_AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK'
] as const

export type ClaudeEnvPatch = {
  CLAUDE_CONFIG_DIR?: string
  ANTHROPIC_CUSTOM_HEADERS?: string
}

export function applyClaudeEnvPatch(
  baseEnv: Record<string, string>,
  patch: ClaudeEnvPatch,
  options?: { stripAuthEnv?: boolean; platform?: NodeJS.Platform }
): Record<string, string> {
  if (options?.stripAuthEnv) {
    for (const key of CLAUDE_AUTH_ENV_VARS) {
      delete baseEnv[key]
    }
    const platform = options.platform ?? process.platform
    for (const key of Object.keys(baseEnv)) {
      const normalized = platform === 'win32' ? key.toUpperCase() : key
      if (
        (platform === 'win32' && CLAUDE_AUTH_ENV_VARS.some((authKey) => authKey === normalized)) ||
        (normalized === 'ANTHROPIC_CUSTOM_HEADERS' && isAuthLikeCustomHeaders(baseEnv[key]))
      ) {
        delete baseEnv[key]
      }
    }
  }

  if (patch.CLAUDE_CONFIG_DIR) {
    baseEnv.CLAUDE_CONFIG_DIR = patch.CLAUDE_CONFIG_DIR
  }
  if (patch.ANTHROPIC_CUSTOM_HEADERS !== undefined) {
    baseEnv.ANTHROPIC_CUSTOM_HEADERS = patch.ANTHROPIC_CUSTOM_HEADERS
  }

  return baseEnv
}

export function hasClaudeAuthEnvConflict(env: Record<string, string> | undefined): boolean {
  if (!env) {
    return false
  }
  return (
    CLAUDE_AUTH_ENV_VARS.some((key) => Boolean(env[key])) ||
    isAuthLikeCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS)
  )
}

function isAuthLikeCustomHeaders(value: string | undefined): boolean {
  if (!value) {
    return false
  }
  return /authorization|x-api-key|api-key|bearer/i.test(value)
}
