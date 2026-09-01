import { createAgent } from 'ssh2'

/**
 * A local agent answers `REQUEST_IDENTITIES` in about a millisecond. This bound only
 * exists so a wedged socket cannot stall a connect attempt behind it.
 */
export const AGENT_IDENTITY_PROBE_TIMEOUT_MS = 750

/**
 * How many identities the agent at `socketPath` offers, or `undefined` when it could
 * not be asked.
 *
 * A refusal, a hang, or a reply we cannot read are all "unknown" — never zero. Nothing
 * may read silence as an empty agent, because the caller's whole reason to ask is to
 * decide against the socket it is probing.
 */
export function probeAgentIdentityCount(
  socketPath: string,
  timeoutMs: number = AGENT_IDENTITY_PROBE_TIMEOUT_MS
): Promise<number | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (count: number | undefined): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(count)
    }
    const timer = setTimeout(() => settle(undefined), timeoutMs)
    timer.unref?.()
    try {
      createAgent(socketPath).getIdentities((error, keys) =>
        settle(error || !keys ? undefined : keys.length)
      )
    } catch {
      settle(undefined)
    }
  })
}
