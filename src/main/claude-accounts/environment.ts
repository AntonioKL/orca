import type { ClaudeManagedAccount } from '../../shared/managed-account-types'

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

/** One string for every transport, so a terminal launch and a structured launch
 *  cannot drift into telling the user two different things about one refusal. */
export const CLAUDE_AUTH_ENV_CONFLICT_MESSAGE =
  'This Claude launch defines explicit Anthropic auth environment variables. Remove those overrides before using a managed Claude account.'

export const CLAUDE_AUTH_SWITCH_IN_PROGRESS_MESSAGE =
  'A Claude account switch is in progress. Try again after it finishes.'

/**
 * Whether a launch on the host runtime must drop inherited Anthropic auth.
 *
 * Only a pinned host-managed account owns the credential, so only it may strip:
 * with no managed account the user's own `ANTHROPIC_*` is their sign-in, and
 * removing it signs them out of a CLI that would otherwise have worked.
 */
export function shouldStripClaudeAuthEnvForAccount(
  accounts: readonly ClaudeManagedAccount[] | undefined,
  activeAccountId: string | null | undefined
): boolean {
  if (!activeAccountId) {
    return false
  }
  return (
    (accounts ?? []).find((account) => account.id === activeAccountId)?.managedAuthRuntime !== 'wsl'
  )
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
