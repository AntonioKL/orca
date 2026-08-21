import { session, type Session } from 'electron'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'
import { applyProxySettingsToSession } from '../network/proxy-settings'
import type { NetworkProxySettings } from '../../shared/network-proxy'

// Why: browser modules hold no store handle, so main injects a reader the way rate-limits does.
let resolveNetworkProxySettings: (() => NetworkProxySettings) | null = null
let proxyPolicyGeneration = 0

export function setBrowserNetworkProxySettingsResolver(
  resolver: (() => NetworkProxySettings) | null
): void {
  resolveNetworkProxySettings = resolver
  if (!resolver) {
    proxyPolicyGeneration = 0
  }
}

export async function applyProxyToBrowserSession(sess: Session): Promise<void> {
  let observedGeneration: number
  do {
    observedGeneration = proxyPolicyGeneration
    const resolved = resolveNetworkProxySettings?.()
    if (!resolved) {
      return
    }
    await applyProxySettingsToSession(sess, resolved)
  } while (observedGeneration !== proxyPolicyGeneration)
}

/** Re-apply the app-wide proxy across every browser partition. */
export async function applyBrowserSessionProxies(
  profiles: BrowserSessionProfile[],
  settings?: NetworkProxySettings
): Promise<void> {
  const resolved = settings ?? resolveNetworkProxySettings?.()
  if (!resolved) {
    return
  }
  proxyPolicyGeneration += 1
  await Promise.all(
    profiles.map(async (profile) => {
      try {
        await applyProxySettingsToSession(session.fromPartition(profile.partition), resolved)
      } catch {
        console.warn('[proxy] Failed to apply proxy to browser partition', profile.partition)
      }
    })
  )
}
