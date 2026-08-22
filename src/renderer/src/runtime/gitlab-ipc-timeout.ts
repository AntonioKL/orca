import { translate } from '@/i18n/i18n'

/** Matches the bound `callRuntimeRpc` applies to the equivalent remote GitLab call. */
export const GITLAB_IPC_TIMEOUT_MS = 30_000

/**
 * Bound a local `window.api.gl.*` IPC call the way `callRuntimeRpc` bounds the remote one.
 *
 * `glab` runs without a subprocess timeout in main, so an unreachable GitLab host would
 * otherwise leave the caller's loading state spinning forever.
 */
export function withGitLabIpcTimeout<T>(
  pending: Promise<T>,
  options?: { timeoutMs?: number; message?: string }
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? GITLAB_IPC_TIMEOUT_MS
  // Called per-request, not at module scope, so the active locale applies.
  const message =
    options?.message ??
    translate('auto.runtime.gitlabIpcTimeout.timedOut', 'Timed out talking to GitLab.')
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(message))
      }, timeoutMs)
    })
  ]).finally(() => {
    clearTimeout(timer)
  })
}
