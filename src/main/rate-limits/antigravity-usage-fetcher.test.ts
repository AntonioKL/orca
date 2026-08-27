import { describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_NOT_RUNNING_REASON,
  ANTIGRAVITY_SIGNED_OUT_REASON,
  fetchAntigravityRateLimits,
  type AntigravityQuotaTransport
} from './antigravity-usage-fetcher'
import type { AntigravityLogSource } from './antigravity-language-server-log'

/** Verbatim body `agy` 1.1.21 returns for a quota call while signed out — HTTP 500, not 401. */
const SIGNED_OUT_BODY = JSON.stringify({
  code: 'internal',
  message:
    'internal: failed to get load code assist response: error getting token source: You are not logged into Antigravity. (error ID: 8606ec051d934dbfbc4d19a97757d18b)'
})

const OK_BODY = JSON.stringify({
  buckets: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-5h', remainingFraction: 0.8, resetTime: '2026-08-26T23:04:43Z' },
        { bucketId: 'gemini-weekly', remainingFraction: 0.5, resetTime: '2026-09-02T18:04:43Z' }
      ]
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { bucketId: '3p-5h', remainingFraction: 0.1, resetTime: '2026-08-26T23:04:43Z' },
        { bucketId: '3p-weekly', remainingFraction: 1, resetTime: '2026-09-02T18:04:43Z' }
      ]
    }
  ]
})

function logHead(pid: number, httpPort: number, httpsPort?: number): string {
  return [
    `server.go:1485] Starting language server process with pid ${pid}`,
    httpsPort === undefined
      ? ''
      : `server.go:597] Language server listening on random port at ${httpsPort} for HTTPS (gRPC)`,
    `server.go:605] Language server listening on random port at ${httpPort} for HTTP`
  ]
    .filter(Boolean)
    .join('\n')
}

function runningServers(heads: Record<string, string>, alivePids?: number[]): AntigravityLogSource {
  return {
    listLogFileNames: async () => Object.keys(heads),
    readLogHead: async (name) => heads[name] ?? null,
    isProcessAlive: (pid) => alivePids?.includes(pid) ?? true
  }
}

describe('fetchAntigravityRateLimits', () => {
  it('reports both Antigravity pools from the language server', async () => {
    const transport: AntigravityQuotaTransport = vi.fn(async () => ({
      statusCode: 200,
      body: OK_BODY
    }))

    const limits = await fetchAntigravityRateLimits({
      logSource: runningServers({ 'cli-20260826_194033.log': logHead(82413, 61383) }),
      transport
    })

    expect(limits.provider).toBe('antigravity')
    expect(limits.status).toBe('ok')
    expect(limits.error).toBeNull()
    expect(limits.buckets?.map((bucket) => bucket.name)).toEqual([
      'Gemini Models · 5h',
      'Gemini Models · 7d',
      'Claude and GPT models · 5h',
      'Claude and GPT models · 7d'
    ])
    expect(limits.session?.usedPercent).toBe(90)
    expect(limits.weekly?.usedPercent).toBe(50)
  })

  // Why: the plaintext port needs no self-signed TLS exception, so it must be tried first.
  it('prefers the plaintext loopback port over the TLS port', async () => {
    const transport: AntigravityQuotaTransport = vi.fn(async () => ({
      statusCode: 200,
      body: OK_BODY
    }))

    await fetchAntigravityRateLimits({
      logSource: runningServers({ 'cli-20260826_194033.log': logHead(82413, 61383, 61382) }),
      transport
    })

    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport).toHaveBeenCalledWith({ scheme: 'http', port: 61383 }, undefined)
  })

  it('falls back to the TLS port when the plaintext port refuses the connection', async () => {
    const transport: AntigravityQuotaTransport = vi
      .fn<AntigravityQuotaTransport>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ statusCode: 200, body: OK_BODY })

    const limits = await fetchAntigravityRateLimits({
      logSource: runningServers({ 'cli-20260826_194033.log': logHead(82413, 61383, 61382) }),
      transport
    })

    expect(transport).toHaveBeenLastCalledWith({ scheme: 'https', port: 61382 }, undefined)
    expect(limits.status).toBe('ok')
  })

  // Why: "no agy running" and "agy running but signed out" need different user actions, and the
  // old mirror collapsed both into a Gemini-flavoured "Token refresh failed".
  it('reports a missing language server distinctly from a signed-out one', async () => {
    const absent = await fetchAntigravityRateLimits({
      logSource: runningServers({}),
      transport: vi.fn()
    })

    expect(absent.status).toBe('unavailable')
    expect(absent.error).toBe(ANTIGRAVITY_NOT_RUNNING_REASON)
    expect(absent.usageMetadata?.failureKind).toBe('cli-unavailable')

    const signedOut = await fetchAntigravityRateLimits({
      logSource: runningServers({ 'cli-20260826_194033.log': logHead(82413, 61383) }),
      transport: async () => ({ statusCode: 500, body: SIGNED_OUT_BODY })
    })

    expect(signedOut.status).toBe('unavailable')
    expect(signedOut.error).toBe(ANTIGRAVITY_SIGNED_OUT_REASON)
    expect(signedOut.usageMetadata?.failureKind).toBe('missing-credentials')
  })

  // Why: a signed-out answer is a settled fact about the account, not a transient server fault;
  // classifying it as `error` would put the segment in the retry lane forever.
  it('never downgrades a signed-out answer to a transient error', async () => {
    const limits = await fetchAntigravityRateLimits({
      logSource: runningServers({
        'cli-20260826_194033.log': logHead(82413, 61383),
        'cli-20260821_123102.log': logHead(70000, 51000)
      }),
      transport: async (target) =>
        target.port === 61383
          ? { statusCode: 500, body: SIGNED_OUT_BODY }
          : { statusCode: 503, body: 'unavailable' }
    })

    expect(limits.status).toBe('unavailable')
    expect(limits.error).toBe(ANTIGRAVITY_SIGNED_OUT_REASON)
  })

  // Why: an older `agy` still holds the account it started with. If the newest run says the
  // user is signed out, reporting the old process's numbers would render a stale account's
  // quota with nothing to indicate it — the exact hazard newest-first ordering exists to stop.
  it('does not fall back to an older server after the newest reports signed out', async () => {
    const transport: AntigravityQuotaTransport = vi.fn(async (target) =>
      target.port === 61383
        ? { statusCode: 500, body: SIGNED_OUT_BODY }
        : { statusCode: 200, body: OK_BODY }
    )

    const limits = await fetchAntigravityRateLimits({
      logSource: runningServers({
        'cli-20260826_194033.log': logHead(82413, 61383),
        'cli-20260821_123102.log': logHead(70000, 51000)
      }),
      transport
    })

    expect(limits.status).toBe('unavailable')
    expect(limits.session).toBeNull()
    expect(transport).toHaveBeenCalledTimes(1)
  })

  // Why: a transport failure teaches nothing about the account, so an older live server is
  // still worth asking — that is the one case where falling through is correct.
  it('falls through to an older server when the newest cannot be reached at all', async () => {
    const limits = await fetchAntigravityRateLimits({
      logSource: runningServers({
        'cli-20260826_194033.log': logHead(82413, 61383),
        'cli-20260821_123102.log': logHead(70000, 51000)
      }),
      transport: async (target) => {
        if (target.port === 61383) {
          throw new Error('ECONNREFUSED')
        }
        return { statusCode: 200, body: OK_BODY }
      }
    })

    expect(limits.status).toBe('ok')
  })

  it('surfaces a non-quota server failure as a retryable error', async () => {
    const limits = await fetchAntigravityRateLimits({
      logSource: runningServers({ 'cli-20260826_194033.log': logHead(82413, 61383) }),
      transport: async () => ({ statusCode: 503, body: 'nope' })
    })

    expect(limits.status).toBe('error')
    expect(limits.error).toContain('503')
    expect(limits.usageMetadata?.failureKind).toBe('server')
  })

  it('reports a parse failure rather than an empty ok snapshot', async () => {
    const limits = await fetchAntigravityRateLimits({
      logSource: runningServers({ 'cli-20260826_194033.log': logHead(82413, 61383) }),
      transport: async () => ({ statusCode: 200, body: 'not json' })
    })

    expect(limits.status).toBe('error')
    expect(limits.usageMetadata?.failureKind).toBe('parse')
    expect(limits.session).toBeNull()
  })

  // Why: an older `agy` keeps a signed-out account in memory, so the newest run must answer first.
  it('asks the newest live language server before older ones', async () => {
    const transport: AntigravityQuotaTransport = vi.fn(async () => ({
      statusCode: 200,
      body: OK_BODY
    }))

    await fetchAntigravityRateLimits({
      logSource: runningServers({
        'cli-20260821_123102.log': logHead(70000, 51000),
        'cli-20260826_194033.log': logHead(82413, 61383)
      }),
      transport
    })

    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport).toHaveBeenCalledWith({ scheme: 'http', port: 61383 }, undefined)
  })

  it('ignores a log left behind by an exited process', async () => {
    const limits = await fetchAntigravityRateLimits({
      logSource: runningServers({ 'cli-20260826_194033.log': logHead(82413, 61383) }, []),
      transport: vi.fn()
    })

    expect(limits.error).toBe(ANTIGRAVITY_NOT_RUNNING_REASON)
  })
})
