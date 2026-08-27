import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  createAntigravityLogSource,
  discoverAntigravityLanguageServers,
  type AntigravityLanguageServerEndpoint,
  type AntigravityLogSource
} from './antigravity-language-server-log'
import { parseAntigravityQuotaSummary } from './antigravity-quota-summary'

const QUOTA_RPC_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
const LOOPBACK_HOST = '127.0.0.1'
const REQUEST_TIMEOUT_MS = 2_500
const MAX_RESPONSE_BYTES = 1024 * 1024

export const ANTIGRAVITY_NOT_RUNNING_REASON =
  'Antigravity usage is not available. Start the Antigravity CLI (agy) so Orca can read its quota.'
export const ANTIGRAVITY_SIGNED_OUT_REASON =
  'Antigravity usage is not available. Sign in with the Antigravity CLI (agy) to see your quota.'
export const ANTIGRAVITY_QUOTA_UNREADABLE_REASON =
  'Antigravity usage is not available. The Antigravity CLI did not report a readable quota.'

export type QuotaSummaryResponse = { statusCode: number; body: string }

export type AntigravityQuotaTransport = (
  target: { scheme: 'http' | 'https'; port: number },
  signal?: AbortSignal
) => Promise<QuotaSummaryResponse>

/**
 * Posts the empty Connect request the LanguageServer expects. The HTTPS port presents a
 * self-signed certificate; that exception is safe only because the request never leaves loopback.
 */
export const requestAntigravityQuotaSummary: AntigravityQuotaTransport = (target, signal) =>
  new Promise((resolve, reject) => {
    const send = target.scheme === 'https' ? httpsRequest : httpRequest
    const req = send(
      {
        host: LOOPBACK_HOST,
        port: target.port,
        path: QUOTA_RPC_PATH,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
        timeout: REQUEST_TIMEOUT_MS,
        ...(target.scheme === 'https' ? { rejectUnauthorized: false } : {})
      },
      (res) => {
        let body = ''
        let overflowed = false
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          if (body.length + chunk.length > MAX_RESPONSE_BYTES) {
            overflowed = true
            req.destroy()
            return
          }
          body += chunk
        })
        res.on('end', () => {
          if (overflowed) {
            reject(new Error('Antigravity quota response too large'))
            return
          }
          resolve({ statusCode: res.statusCode ?? 0, body })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('Antigravity quota request timed out')))
    req.on('error', reject)
    signal?.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
    req.end('{}')
  })

function unavailable(
  reason: string,
  failureKind: 'cli-unavailable' | 'missing-credentials'
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: reason,
    status: 'unavailable',
    usageMetadata: { source: 'cli', failureKind }
  }
}

function failed(reason: string, failureKind: 'server' | 'parse' | 'network'): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: reason,
    status: 'error',
    usageMetadata: { source: 'cli', failureKind }
  }
}

/** `agy` answers a signed-out quota call with HTTP 500 and this phrase, not with a 401. */
function isSignedOutResponse(response: QuotaSummaryResponse): boolean {
  return response.statusCode >= 400 && /not logged into antigravity/i.test(response.body)
}

function endpointTargets(
  endpoint: AntigravityLanguageServerEndpoint
): { scheme: 'http' | 'https'; port: number }[] {
  const targets: { scheme: 'http' | 'https'; port: number }[] = []
  // Why: prefer the plaintext port so the common path needs no self-signed TLS exception at all.
  if (endpoint.httpPort !== null) {
    targets.push({ scheme: 'http', port: endpoint.httpPort })
  }
  if (endpoint.httpsPort !== null) {
    targets.push({ scheme: 'https', port: endpoint.httpsPort })
  }
  return targets
}

export type AntigravityUsageFetchOptions = {
  signal?: AbortSignal
  logSource?: AntigravityLogSource
  transport?: AntigravityQuotaTransport
}

/**
 * Reads Antigravity quota from Antigravity's own host-local LanguageServer.
 *
 * Why not the Gemini snapshot: the two products bill different pools, and `agy` keeps its token in
 * the OS keyring where no Gemini CLI credential file can describe it (#9122).
 */
export async function fetchAntigravityRateLimits(
  options: AntigravityUsageFetchOptions = {}
): Promise<ProviderRateLimits> {
  const logSource = options.logSource ?? createAntigravityLogSource()
  const transport = options.transport ?? requestAntigravityQuotaSummary
  const endpoints = await discoverAntigravityLanguageServers(logSource)
  if (endpoints.length === 0) {
    return unavailable(ANTIGRAVITY_NOT_RUNNING_REASON, 'cli-unavailable')
  }

  let signedOut = false
  let lastFailure: ProviderRateLimits | null = null
  for (const endpoint of endpoints) {
    for (const target of endpointTargets(endpoint)) {
      if (options.signal?.aborted) {
        return failed('Antigravity quota fetch was cancelled', 'network')
      }
      let response: QuotaSummaryResponse
      try {
        response = await transport(target, options.signal)
      } catch (err) {
        lastFailure = failed(
          err instanceof Error ? err.message : 'Antigravity quota request failed',
          'network'
        )
        continue
      }
      if (isSignedOutResponse(response)) {
        // Why: the newest run owns the current account; keep probing older ones only to
        // confirm nothing better exists, but never downgrade this to a transient error.
        signedOut = true
        continue
      }
      if (response.statusCode !== 200) {
        lastFailure = failed(`Antigravity quota fetch failed (${response.statusCode})`, 'server')
        continue
      }
      let parsed: ReturnType<typeof parseAntigravityQuotaSummary>
      try {
        parsed = parseAntigravityQuotaSummary(JSON.parse(response.body))
      } catch {
        parsed = null
      }
      if (!parsed) {
        lastFailure = failed(ANTIGRAVITY_QUOTA_UNREADABLE_REASON, 'parse')
        continue
      }
      return {
        provider: 'antigravity',
        session: parsed.session,
        weekly: parsed.weekly,
        buckets: parsed.buckets,
        updatedAt: Date.now(),
        error: null,
        status: 'ok',
        usageMetadata: { source: 'cli' }
      }
    }
  }

  if (signedOut) {
    return unavailable(ANTIGRAVITY_SIGNED_OUT_REASON, 'missing-credentials')
  }
  return lastFailure ?? unavailable(ANTIGRAVITY_NOT_RUNNING_REASON, 'cli-unavailable')
}
