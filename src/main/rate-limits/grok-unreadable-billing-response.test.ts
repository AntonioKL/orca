import { beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
const authState = vi.hoisted<{ file: string | null }>(() => ({ file: null }))

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))
vi.mock('node:fs', () => ({
  existsSync: () => authState.file !== null,
  readFileSync: () => {
    if (authState.file === null) {
      throw new Error('ENOENT')
    }
    return authState.file
  }
}))
vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

import { fetchGrokRateLimits } from './grok-fetcher'

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function freshAuthJson(): string {
  return JSON.stringify({
    'https://auth.x.ai::client': {
      key: 'access-token',
      user_id: 'user-1',
      email: 'dev@example.com',
      expires_at: '2099-01-01T00:00:00.000Z'
    }
  })
}

// Why: `unavailable` is the "provider is not set up" signal — the stale policy discards the last
// good snapshot for it and the status bar hides the chip. That is only honest about a billing view
// Orca could actually read; a body that is not an object at all is a failed read.
describe('Grok billing responses Orca cannot read', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
    authState.file = freshAuthJson()
  })

  const unreadableBodies: [string, unknown][] = [
    ['a JSON array', []],
    ['a bare string', 'nope'],
    ['a bare number', 7],
    ['a null body', null]
  ]

  for (const [label, body] of unreadableBodies) {
    it(`reports ${label} as a failed reading, not an unconfigured account`, async () => {
      netFetchMock.mockResolvedValue(jsonResponse(body))

      const result = await fetchGrokRateLimits()

      expect(result.status).toBe('error')
      expect(result.error).toBeTruthy()
    })
  }

  // Why: an object with no credit fields is the documented "this plan has no weekly credits"
  // answer — a genuine empty reading, and it must keep behaving like one.
  it('still reports a readable billing view with no credits as unavailable', async () => {
    netFetchMock.mockResolvedValue(jsonResponse({}))

    await expect(fetchGrokRateLimits()).resolves.toMatchObject({ status: 'unavailable' })
  })
})
