import { session } from 'electron'
import { normalizeProxyUrl } from '../../shared/network-proxy'

export type ElectronProxyCredentials = {
  host: string
  port: number
  username: string
  password: string
}

export type ElectronProxyConfig = {
  proxyRules: string
  credentials: ElectronProxyCredentials | null
}

const DEFAULT_PROXY_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
  'socks:': 1080,
  'socks4:': 1080,
  'socks5:': 1080
}

let proxyCredentialsBySession = new WeakMap<object, ElectronProxyCredentials>()

function decodeProxyCredential(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function normalizeProxyHost(host: string): string {
  return host.replace(/^\[|\]$/g, '').toLowerCase()
}

export function separateElectronProxyCredentials(proxyUrl: string): ElectronProxyConfig {
  const url = new URL(proxyUrl)
  const hasCredentials = Boolean(url.username || url.password)
  const credentials = hasCredentials
    ? {
        host: normalizeProxyHost(url.hostname),
        port: url.port ? Number(url.port) : (DEFAULT_PROXY_PORTS[url.protocol] ?? 0),
        username: decodeProxyCredential(url.username),
        password: decodeProxyCredential(url.password)
      }
    : null
  url.username = ''
  url.password = ''
  const normalized = normalizeProxyUrl(url.toString())
  return { proxyRules: normalized.ok ? normalized.value : '', credentials }
}

export function haveSameElectronProxyCredentials(
  left: ElectronProxyCredentials | null,
  right: ElectronProxyCredentials | null
): boolean {
  return (
    left?.host === right?.host &&
    left?.port === right?.port &&
    left?.username === right?.username &&
    left?.password === right?.password
  )
}

export function setElectronProxyCredentialsForSession(
  proxySession: object,
  credentials: ElectronProxyCredentials | null
): void {
  if (credentials) {
    proxyCredentialsBySession.set(proxySession, credentials)
  } else {
    proxyCredentialsBySession.delete(proxySession)
  }
}

export function resetElectronProxyCredentialsForTests(proxySession?: object): void {
  if (proxySession) {
    proxyCredentialsBySession.delete(proxySession)
  } else {
    proxyCredentialsBySession = new WeakMap()
  }
}

export function handleElectronProxyLogin(
  event: Electron.Event,
  webContents: Electron.WebContents | null,
  _authenticationResponseDetails: Electron.AuthenticationResponseDetails,
  authInfo: Electron.AuthInfo,
  callback: (username?: string, password?: string) => void
): void {
  if (!authInfo.isProxy) {
    return
  }
  const proxySession = webContents?.session ?? session.defaultSession
  const credentials = proxyCredentialsBySession.get(proxySession)
  if (
    !credentials ||
    credentials.host !== normalizeProxyHost(authInfo.host) ||
    credentials.port !== authInfo.port
  ) {
    return
  }
  event.preventDefault()
  callback(credentials.username, credentials.password)
}
