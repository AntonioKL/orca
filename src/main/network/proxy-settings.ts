import {
  getProxyBypassRulesFromEnvironment,
  getProxyUrlFromEnvironment,
  normalizeProxyBypassRules,
  normalizeProxyUrl,
  type NetworkProxySettings
} from '../../shared/network-proxy'
import {
  clearElectronProxyCredentialsForSession,
  haveSameElectronProxyCredentials,
  resetElectronProxyCredentialsForTests,
  separateElectronProxyCredentials,
  setElectronProxyCredentialsForSession,
  type ElectronProxyCredentials
} from './electron-proxy-credentials'
import { resolveProxyPolicyWithoutSession, type ProxyApplyResult } from './proxy-policy-resolution'

type ProxySession = {
  resolveProxy(url: string): Promise<string>
  setProxy(config: {
    mode?: 'system' | 'fixed_servers'
    proxyRules?: string
    proxyBypassRules?: string
  }): Promise<void>
  closeAllConnections?: () => Promise<void>
}

/**
 * The default proxy session, or null on a host with no Chromium.
 *
 * Why settable: `session.defaultSession` is the only Electron value this module needs,
 * and callers already accept an explicit `options.proxySession`. Making the *default*
 * injectable lets the module load under plain Node, where there is no Chromium proxy
 * config to consult and the environment variables are the whole answer.
 */
let resolveDefaultProxySession: (() => ProxySession | null) | null = null

/**
 * Why a resolver and not a Session: `session.defaultSession` throws until the Electron
 * app is ready, and this is installed during pre-ready bootstrap. Passing a getter
 * defers the access to first use, which is always after ready.
 */
export function setDefaultProxySessionResolver(resolve: (() => ProxySession | null) | null): void {
  resolveDefaultProxySession = resolve
}

function defaultProxySession(): ProxySession | null {
  return resolveDefaultProxySession?.() ?? null
}

export type { ProxyApplyResult } from './proxy-policy-resolution'

const PROXY_PROBE_URL = 'https://api.anthropic.com/'

type SessionProxyApplicationState = {
  appliedKey: string | null
  settledKey: string | null
  appliedResult: Extract<ProxyApplyResult, { source: 'settings' | 'env' }> | null
  credentials: ElectronProxyCredentials | null
  tail: Promise<unknown>
  readiness: 'ready' | 'pending' | 'failed'
}

let sessionProxyApplications = new WeakMap<ProxySession, SessionProxyApplicationState>()

function proxyMemoKey(result: ProxyApplyResult): string {
  return result.source === 'settings' || result.source === 'env'
    ? `${result.source}\0${result.proxyRules}\0${result.proxyBypassRules ?? ''}`
    : result.source
}

export function resetProxyApplicationForTests(): void {
  sessionProxyApplications = new WeakMap()
  resetElectronProxyCredentialsForTests()
}

export function resetSessionProxyApplicationForTests(proxySession: ProxySession): void {
  sessionProxyApplications.delete(proxySession)
  clearElectronProxyCredentialsForSession(proxySession)
}

/** Wait for the newest queued policy; false keeps requests fail-closed after an apply error. */
export async function awaitProxySessionApplication(proxySession: ProxySession): Promise<boolean> {
  while (true) {
    const state = sessionProxyApplications.get(proxySession)
    if (!state) {
      return true
    }
    const observed = state.tail
    try {
      await observed
    } catch {
      if (state.tail === observed) {
        return false
      }
      continue
    }
    if (state.tail === observed) {
      return true
    }
  }
}

export function getProxySessionApplicationReadiness(
  proxySession: ProxySession
): boolean | Promise<boolean> {
  const state = sessionProxyApplications.get(proxySession)
  if (!state || state.readiness === 'ready') {
    return true
  }
  if (state.readiness === 'failed') {
    return false
  }
  return awaitProxySessionApplication(proxySession)
}

export async function releaseProxySessionApplication(proxySession: ProxySession): Promise<void> {
  await enqueueSessionProxyApplication(proxySession, async (state) => {
    await releaseSessionProxyPin(proxySession, state)
    clearElectronProxyCredentialsForSession(proxySession)
    return { source: 'none' }
  })
}

function getSessionProxyApplicationState(proxySession: ProxySession): SessionProxyApplicationState {
  let state = sessionProxyApplications.get(proxySession)
  if (!state) {
    state = {
      appliedKey: null,
      settledKey: null,
      appliedResult: null,
      credentials: null,
      tail: Promise.resolve(),
      readiness: 'ready'
    }
    sessionProxyApplications.set(proxySession, state)
  }
  return state
}

async function enqueueSessionProxyApplication(
  proxySession: ProxySession,
  apply: (state: SessionProxyApplicationState) => Promise<ProxyApplyResult>
): Promise<ProxyApplyResult> {
  const state = getSessionProxyApplicationState(proxySession)
  const operation = state.tail.catch(() => {}).then(() => apply(state))
  state.tail = operation
  state.readiness = 'pending'
  void operation.then(
    () => {
      if (state.tail === operation) {
        state.readiness = 'ready'
      }
    },
    () => {
      if (state.tail === operation) {
        state.readiness = 'failed'
      }
    }
  )
  return operation
}

/** Apply the app-wide proxy to one session, serializing writes in call order. */
export function applyProxySettingsToSession(
  proxySession: ProxySession,
  settings: NetworkProxySettings,
  options: { env?: Record<string, string | undefined>; probeUrl?: string } = {}
): Promise<ProxyApplyResult> {
  return enqueueSessionProxyApplication(proxySession, (state) =>
    resolveAndApplySessionProxy(proxySession, state, settings, options)
  )
}

async function resolveAndApplySessionProxy(
  proxySession: ProxySession,
  state: SessionProxyApplicationState,
  settings: NetworkProxySettings,
  options: { env?: Record<string, string | undefined>; probeUrl?: string }
): Promise<ProxyApplyResult> {
  const env = options.env ?? process.env
  const configured = normalizeProxyUrl(settings.httpProxyUrl)
  if (configured.ok && configured.value) {
    const { proxyRules, credentials } = separateElectronProxyCredentials(configured.value)
    const bypassRules = normalizeProxyBypassRules(settings.httpProxyBypassRules)
    const result: ProxyApplyResult = {
      source: 'settings',
      proxyRules,
      ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
    }
    return applySessionProxyResult(proxySession, state, result, credentials)
  }

  const envProxy = getProxyUrlFromEnvironment(env)
  if (envProxy.ok && envProxy.value) {
    const { proxyRules, credentials } = separateElectronProxyCredentials(envProxy.value)
    const bypassRules = normalizeProxyBypassRules(getProxyBypassRulesFromEnvironment(env))
    const result: Extract<ProxyApplyResult, { source: 'env' }> = {
      source: 'env',
      proxyRules,
      ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
    }
    if (
      state.settledKey === proxyMemoKey(result) &&
      haveSameElectronProxyCredentials(state.credentials, credentials)
    ) {
      return result
    }
  }

  // Why: a pinned session resolves to its own pin, so release it before probing the system proxy.
  await releaseSessionProxyPin(proxySession, state)
  if ((await proxySession.resolveProxy(options.probeUrl ?? PROXY_PROBE_URL)) !== 'DIRECT') {
    return { source: 'system' }
  }
  if (!envProxy.ok) {
    return { source: configured.ok ? 'invalid-env' : 'invalid-settings' }
  }
  if (!envProxy.value) {
    return { source: configured.ok ? 'none' : 'invalid-settings' }
  }

  const { proxyRules, credentials } = separateElectronProxyCredentials(envProxy.value)
  const bypassRules = normalizeProxyBypassRules(getProxyBypassRulesFromEnvironment(env))
  return applySessionProxyResult(
    proxySession,
    state,
    {
      source: 'env',
      proxyRules,
      ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
    },
    credentials
  )
}

async function releaseSessionProxyPin(
  proxySession: ProxySession,
  state: SessionProxyApplicationState
): Promise<void> {
  if (state.appliedKey === null) {
    return
  }
  await proxySession.setProxy({ mode: 'system' })
  // Why: the pin is gone before the best-effort connection close can reject.
  state.appliedKey = null
  state.settledKey = null
  state.appliedResult = null
  state.credentials = null
  setElectronProxyCredentialsForSession(proxySession, null)
  await proxySession.closeAllConnections?.()
}

async function applySessionProxyResult(
  proxySession: ProxySession,
  state: SessionProxyApplicationState,
  result: Extract<ProxyApplyResult, { source: 'settings' | 'env' }>,
  credentials: ElectronProxyCredentials | null
): Promise<ProxyApplyResult> {
  const key = proxyMemoKey(result)
  if (
    state.settledKey === key &&
    haveSameElectronProxyCredentials(state.credentials, credentials)
  ) {
    return result
  }
  await proxySession.setProxy({
    mode: 'fixed_servers',
    proxyRules: result.proxyRules,
    ...(result.proxyBypassRules ? { proxyBypassRules: result.proxyBypassRules } : {})
  })
  state.appliedKey = key
  state.settledKey = null
  state.appliedResult = result
  state.credentials = credentials
  setElectronProxyCredentialsForSession(proxySession, credentials)
  await proxySession.closeAllConnections?.()
  state.settledKey = key
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
  const proxySession = options.proxySession ?? defaultProxySession()
  if (!proxySession) {
    return resolveProxyPolicyWithoutSession({}, options.env ?? process.env)
  }
  return enqueueSessionProxyApplication(proxySession, (state) => {
    if (!options.force && state.appliedResult !== null) {
      if (state.settledKey === proxyMemoKey(state.appliedResult)) {
        return Promise.resolve(state.appliedResult)
      }
      return applySessionProxyResult(proxySession, state, state.appliedResult, state.credentials)
    }
    return resolveAndApplySessionProxy(proxySession, state, {}, options)
  })
}

export function applyElectronProxySettings(
  settings: NetworkProxySettings,
  options: {
    proxySession?: ProxySession
    env?: Record<string, string | undefined>
    probeUrl?: string
  } = {}
): Promise<ProxyApplyResult> {
  const proxySession = options.proxySession ?? defaultProxySession()
  if (!proxySession) {
    return Promise.resolve(resolveProxyPolicyWithoutSession(settings, options.env ?? process.env))
  }
  return applyProxySettingsToSession(proxySession, settings, {
    env: options.env,
    probeUrl: options.probeUrl
  })
}
