import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { fetchClaudeRateLimits } from './claude-fetcher'
import { primeClaudeFetcherMocks, restorePlatform } from './claude-fetcher-test-harness'
import { fetchViaPty } from './claude-pty'
import { readActiveClaudeKeychainCredentialsStrict } from '../claude-accounts/keychain'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

const { netFetchMock, readFileMock, resolveProxyMock, setProxyMock, appGetPathMock } = vi.hoisted(
  () => ({
    netFetchMock: vi.fn(),
    readFileMock: vi.fn(),
    resolveProxyMock: vi.fn(),
    setProxyMock: vi.fn(),
    appGetPathMock: vi.fn()
  })
)

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  net: { fetch: netFetchMock },
  session: {
    defaultSession: { resolveProxy: resolveProxyMock, setProxy: setProxyMock }
  }
}))

vi.mock('./claude-pty', () => ({
  fetchViaPty: vi.fn()
}))

vi.mock('../claude-accounts/keychain', () => ({
  deleteActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readActiveClaudeKeychainCredentials: vi.fn(),
  readActiveClaudeKeychainCredentialsStrict: vi.fn(),
  readManagedClaudeKeychainCredentials: vi.fn(),
  writeActiveClaudeKeychainCredentials: vi.fn(),
  writeManagedClaudeKeychainCredentials: vi.fn()
}))

const CONFIG_DIR = '/Users/test/.claude'
const authPreparation: ClaudeRuntimeAuthPreparation = {
  configDir: CONFIG_DIR,
  envPatch: { CLAUDE_CONFIG_DIR: CONFIG_DIR },
  stripAuthEnv: false,
  provenance: 'system'
}

function primeOAuthToken(): void {
  vi.mocked(readActiveClaudeKeychainCredentialsStrict).mockResolvedValueOnce(
    JSON.stringify({
      claudeAiOauth: { accessToken: 'oauth-token', expiresAt: Date.now() + 60_000 }
    })
  )
}

// Why: the stale policy treats `ok` as fresh and writes it over the last good snapshot, so a
// 200 Orca could not read a window out of must never settle as a successful reading.
describe('Claude OAuth usage readings that carry no window', () => {
  beforeEach(() => {
    primeClaudeFetcherMocks({
      netFetchMock,
      readFileMock,
      resolveProxyMock,
      setProxyMock,
      appGetPathMock
    })
    vi.mocked(fetchViaPty).mockResolvedValue({
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'CLI exited before /usage rendered',
      status: 'error'
    })
  })

  afterEach(() => {
    restorePlatform()
  })

  const unreadableBodies: [string, string][] = [
    ['a JSON array', '[]'],
    ['a bare string', '"nope"'],
    ['a bare number', '7'],
    ['an error envelope', '{"error":{"type":"overloaded_error","message":"Overloaded"}}'],
    ['an object with no usage key', '{"detail":"Not Found"}'],
    ['a malformed five_hour field', '{"five_hour":"eighty percent"}']
  ]

  for (const [label, body] of unreadableBodies) {
    it(`does not report ${label} as a successful usage reading`, async () => {
      primeOAuthToken()
      netFetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }))

      const limits = await fetchClaudeRateLimits({ authPreparation })

      expect(limits.status).not.toBe('ok')
      expect(limits.session).toBeNull()
      expect(limits.weekly).toBeNull()
      expect(limits.error).toBeTruthy()
    })
  }

  it('still reports a readable window as a successful reading', async () => {
    primeOAuthToken()
    netFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ five_hour: { utilization: 36 } }), { status: 200 })
    )

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      status: 'ok',
      session: { usedPercent: 36 }
    })
  })

  // Why: an unreadable body is a failed read, not a missing account — the CLI can still answer.
  it('falls back to the CLI read when the OAuth body carries no window', async () => {
    primeOAuthToken()
    netFetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))
    vi.mocked(fetchViaPty).mockResolvedValueOnce({
      provider: 'claude',
      session: { usedPercent: 12, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    })

    await expect(fetchClaudeRateLimits({ authPreparation })).resolves.toMatchObject({
      status: 'ok',
      session: { usedPercent: 12 }
    })
    expect(fetchViaPty).toHaveBeenCalled()
  })
})
