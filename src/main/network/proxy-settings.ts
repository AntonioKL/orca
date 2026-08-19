import type { Session } from 'electron'

/**
 * The default proxy session, or null on a host with no Chromium.
 *
 * Why settable: `session.defaultSession` is the only Electron value this module needs,
 * and callers already accept an explicit `options.proxySession`. Making the *default*
 * injectable lets the module load under plain Node, where there is no Chromium proxy
 * config to consult and the environment variables are the whole answer.
 */
let resolveDefaultProxySession: (() => Session | null) | null = null

/**
 * Why a resolver and not a Session: `session.defaultSession` throws until the Electron
 * app is ready, and this is installed during pre-ready bootstrap. Passing a getter
 * defers the access to first use, which is always after ready.
 */
export function setDefaultProxySessionResolver(resolve: (() => Session | null) | null): void {
  resolveDefaultProxySession = resolve
}

function defaultProxySession(): Session | null {
  return resolveDefaultProxySession?.() ?? null
}

/** Apply proxy rules only when a Chromium session exists; a Node host has none to configure. */
async function setSessionProxyIfPresent(
  proxySession: ProxySession | Session | null,
  config: Parameters<typeof setSessionProxy>[1]
): Promise<void> {
  if (!proxySession) {
    return
  }
  await setSessionProxy(proxySession as ProxySession, config)
}
import {
  getProxyBypassRulesFromEnvironment,
  getProxyUrlFromEnvironment,
  normalizeProxyBypassRules,
  normalizeProxyUrl,
  type NetworkProxySettings
} from '../../shared/network-proxy'

type ProxySession = {
  resolveProxy(url: string): Promise<string>
  setProxy(config: {
    mode?: 'system' | 'fixed_servers'
    proxyRules?: string
    proxyBypassRules?: string
  }): Promise<void>
  closeAllConnections?: () => Promise<void>
}

export type ProxyApplyResult =
  | { source: 'settings'; proxyRules: string; proxyBypassRules?: string }
  | { source: 'env'; proxyRules: string; proxyBypassRules?: string }
  | { source: 'system' | 'none' | 'invalid-settings' | 'invalid-env' }

const PROXY_PROBE_URL = 'https://api.anthropic.com/'

let lastAppliedProxyConfig: Extract<ProxyApplyResult, { source: 'settings' | 'env' }> | null = null

async function setSessionProxy(
  proxySession: ProxySession,
  config: Parameters<ProxySession['setProxy']>[0]
): Promise<void> {
  await proxySession.setProxy(config)
  await proxySession.closeAllConnections?.()
}

export function resetProxyApplicationForTests(): void {
  lastAppliedProxyConfig = null
}

// Why: sessions outside defaultSession (browser partitions) need their own applied-config memo;
// the module-global one above tracks defaultSession alone and would skip or clobber their writes.
const appliedSessionProxyKeys = new WeakMap<ProxySession, string>()

function proxyMemoKey(result: ProxyApplyResult): string {
  return result.source === 'settings' || result.source === 'env'
    ? `${result.source}\0${result.proxyRules}\0${result.proxyBypassRules ?? ''}`
    : result.source
}

export function resetSessionProxyApplicationForTests(proxySession: ProxySession): void {
  appliedSessionProxyKeys.delete(proxySession)
}

/**
 * Apply the app-wide proxy to one non-default session, falling back to the environment
 * proxy and then the system proxy exactly as the defaultSession path does.
 */
export async function applyProxySettingsToSession(
  proxySession: ProxySession,
  settings: NetworkProxySettings,
  options: { env?: Record<string, string | undefined>; probeUrl?: string } = {}
): Promise<ProxyApplyResult> {
  const env = options.env ?? process.env
  const configured = normalizeProxyUrl(settings.httpProxyUrl)
  if (configured.ok && configured.value) {
    const bypassRules = normalizeProxyBypassRules(settings.httpProxyBypassRules)
    const result: ProxyApplyResult = {
      source: 'settings',
      proxyRules: configured.value,
      ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
    }
    return applySessionProxyResult(proxySession, result)
  }

  const envProxy = getProxyUrlFromEnvironment(env)
  if (envProxy.ok && envProxy.value) {
    // Why: mirror the defaultSession path — a system proxy already in effect outranks env vars.
    const alreadyProxied =
      !appliedSessionProxyKeys.has(proxySession) &&
      (await proxySession.resolveProxy(options.probeUrl ?? PROXY_PROBE_URL)) !== 'DIRECT'
    if (alreadyProxied) {
      return { source: 'system' }
    }
    const bypassRules = getProxyBypassRulesFromEnvironment(env)
    const result: ProxyApplyResult = {
      source: 'env',
      proxyRules: envProxy.value,
      ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
    }
    return applySessionProxyResult(proxySession, result)
  }

  // Why: only reset a session we previously pinned; an untouched session already follows the system proxy.
  if (appliedSessionProxyKeys.has(proxySession)) {
    await setSessionProxy(proxySession, { mode: 'system' })
    appliedSessionProxyKeys.delete(proxySession)
  }
  return { source: configured.ok ? (envProxy.ok ? 'none' : 'invalid-env') : 'invalid-settings' }
}

async function applySessionProxyResult(
  proxySession: ProxySession,
  result: Extract<ProxyApplyResult, { source: 'settings' | 'env' }>
): Promise<ProxyApplyResult> {
  const key = proxyMemoKey(result)
  if (appliedSessionProxyKeys.get(proxySession) === key) {
    return result
  }
  await setSessionProxy(proxySession, {
    mode: 'fixed_servers',
    proxyRules: result.proxyRules,
    ...(result.proxyBypassRules ? { proxyBypassRules: result.proxyBypassRules } : {})
  })
  appliedSessionProxyKeys.set(proxySession, key)
  return result
}

export async function ensureElectronProxyFromEnvironment(
  options: {
    proxySession?: ProxySession
    env?: Record<string, string | undefined>
    force?: boolean
    probeUrl?: string
  } = {}
): Promise<ProxyApplyResult> {
  if (!options.force && lastAppliedProxyConfig !== null) {
    return lastAppliedProxyConfig
  }

  const proxySession = options.proxySession ?? defaultProxySession()
  // Why not bail: with no Chromium session there is no system proxy to discover, so the
  // environment variables below are the complete answer rather than a fallback.
  const resolved = proxySession
    ? await proxySession.resolveProxy(options.probeUrl ?? PROXY_PROBE_URL)
    : 'DIRECT'
  if (resolved !== 'DIRECT') {
    return { source: 'system' }
  }

  const proxy = getProxyUrlFromEnvironment(options.env ?? process.env)
  if (!proxy.ok) {
    return { source: 'invalid-env' }
  }
  if (!proxy.value) {
    return { source: 'none' }
  }

  const bypassRules = getProxyBypassRulesFromEnvironment(options.env ?? process.env)
  await setSessionProxyIfPresent(proxySession, {
    mode: 'fixed_servers',
    proxyRules: proxy.value,
    ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
  })
  lastAppliedProxyConfig = {
    source: 'env',
    proxyRules: proxy.value,
    ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
  }
  return lastAppliedProxyConfig
}

export async function applyElectronProxySettings(
  settings: NetworkProxySettings,
  options: {
    proxySession?: ProxySession
    env?: Record<string, string | undefined>
    probeUrl?: string
  } = {}
): Promise<ProxyApplyResult> {
  const proxySession = options.proxySession ?? defaultProxySession()
  const proxy = normalizeProxyUrl(settings.httpProxyUrl)
  if (!proxy.ok) {
    return ensureElectronProxyFromEnvironment({
      ...(proxySession ? { proxySession } : {}),
      env: options.env,
      force: lastAppliedProxyConfig !== null,
      probeUrl: options.probeUrl
    }).then((result) => (result.source === 'none' ? { source: 'invalid-settings' } : result))
  }

  // Why guarded: applying proxy rules to a Chromium session is meaningless with no
  // Chromium. The settings are still honoured — outbound requests read the environment.
  if (proxy.value) {
    const bypassRules = normalizeProxyBypassRules(settings.httpProxyBypassRules)
    await setSessionProxyIfPresent(proxySession, {
      mode: 'fixed_servers',
      proxyRules: proxy.value,
      ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
    })
    lastAppliedProxyConfig = {
      source: 'settings',
      proxyRules: proxy.value,
      ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
    }
    return lastAppliedProxyConfig
  }

  if (lastAppliedProxyConfig !== null) {
    await setSessionProxyIfPresent(proxySession, { mode: 'system' })
    lastAppliedProxyConfig = null
  }
  return ensureElectronProxyFromEnvironment({
    ...(proxySession ? { proxySession } : {}),
    env: options.env,
    force: true,
    probeUrl: options.probeUrl
  })
}
