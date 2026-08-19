import { session, type Session } from 'electron'
import { normalizeProxyUrl, type NetworkProxySettings } from '../../shared/network-proxy'
import { applyProxySettingsToSession } from '../network/proxy-settings'

export const OPENCODE_BASE_URL = 'https://opencode.ai'

const OPENCODE_SESSION_PARTITION = 'orca-opencode-go-rate-limit-fetch'

export async function clearOpenCodeSessionCookies(openCodeSession: Session): Promise<void> {
  await openCodeSession.clearStorageData({ origin: OPENCODE_BASE_URL, storages: ['cookies'] })
}

async function ensureProxyForOpenCodeSession(
  openCodeSession: Session,
  networkProxySettings?: NetworkProxySettings
): Promise<void> {
  const configured = normalizeProxyUrl(networkProxySettings?.httpProxyUrl)
  try {
    await applyProxySettingsToSession(openCodeSession, networkProxySettings ?? {}, {
      probeUrl: OPENCODE_BASE_URL
    })
  } catch (error) {
    if (configured.ok && configured.value) {
      throw error
    }
    // Environment proxy bridging is best-effort, matching the app-wide startup path.
  }
}

export async function createOpenCodeRequestSession(
  authCookies: { name: string; value: string }[],
  networkProxySettings?: NetworkProxySettings
): Promise<Session> {
  const openCodeSession = session.fromPartition(OPENCODE_SESSION_PARTITION)
  await clearOpenCodeSessionCookies(openCodeSession)
  // The isolated cookie jar must still honor Orca, environment, and system proxies.
  await ensureProxyForOpenCodeSession(openCodeSession, networkProxySettings)
  try {
    // Sequential writes ensure cleanup cannot race an in-flight cookie write after a rejection.
    for (const { name, value } of authCookies) {
      await openCodeSession.cookies.set({
        url: OPENCODE_BASE_URL,
        name,
        value,
        secure: true,
        path: '/'
      })
    }
    return openCodeSession
  } catch (error) {
    await clearOpenCodeSessionCookies(openCodeSession).catch(() => undefined)
    throw error
  }
}
