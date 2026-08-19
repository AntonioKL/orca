import { session, type Session } from 'electron'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'
import { applyProxySettingsToSession } from '../network/proxy-settings'
import type { NetworkProxySettings } from '../../shared/network-proxy'

// Why: browser modules hold no store handle, so main injects a reader the way rate-limits does.
let resolveNetworkProxySettings: (() => NetworkProxySettings) | null = null

export function setBrowserNetworkProxySettingsResolver(
  resolver: (() => NetworkProxySettings) | null
): void {
  resolveNetworkProxySettings = resolver
}

export async function applyProxyToBrowserSession(
  sess: Session,
  settings?: NetworkProxySettings
): Promise<void> {
  const resolved = settings ?? resolveNetworkProxySettings?.()
  if (!resolved) {
    return
  }
  await applyProxySettingsToSession(sess, resolved)
}

/**
 * Re-apply the app-wide proxy across every browser partition. Used at startup and whenever the
 * proxy settings change, mirroring `applyBrowserSessionUserAgentModes`.
 */
export async function applyBrowserSessionProxies(
  profiles: BrowserSessionProfile[],
  settings?: NetworkProxySettings
): Promise<void> {
  const resolved = settings ?? resolveNetworkProxySettings?.()
  if (!resolved) {
    return
  }
  for (const profile of profiles) {
    try {
      await applyProxySettingsToSession(session.fromPartition(profile.partition), resolved)
    } catch {
      // Why: one unavailable partition must not strand the proxy on the remaining profiles.
    }
  }
}
