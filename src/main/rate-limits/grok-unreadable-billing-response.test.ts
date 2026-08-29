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
import { isProviderConfigured } from '../../renderer/src/components/status-bar/status-bar-provider-visibility'

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

  // Why: `unavailable` does two things at once — the stale policy discards the previous snapshot
  // and `isProviderConfigured` hides the chip. A read that failed may reach neither, so the chip
  // read site is asserted here rather than assumed from the status alone.
  const wrongTypedCarriers: [string, unknown][] = [
    ['an array config', { config: [] }],
    ['a string config', { config: 'invalid' }],
    ['a number config', { config: 7 }],
    ['a boolean config', { config: true }],
    ['a string creditUsagePercent', { creditUsagePercent: '42' }]
  ]

  for (const [label, body] of wrongTypedCarriers) {
    it(`reports ${label} as a failed reading that keeps the chip visible`, async () => {
      netFetchMock.mockResolvedValue(jsonResponse(body))

      const result = await fetchGrokRateLimits()

      expect(result.status).toBe('error')
      expect(isProviderConfigured(result)).toBe(true)
    })
  }

  // Why: the monthly fallback reads a second billing view, and it was mapping the same
  // wrong-typed carrier straight to "no monthly window", which lands on the same `unavailable`.
  it('reports a wrong-typed carrier in the monthly fallback view as a failed reading', async () => {
    netFetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        jsonResponse(url.includes('format=credits') ? { config: {} } : { config: 'invalid' })
      )
    )

    const result = await fetchGrokRateLimits()

    expect(result.status).toBe('error')
    expect(isProviderConfigured(result)).toBe(true)
  })

  // Why: an object with no credit fields is the documented "this plan has no weekly credits"
  // answer — a genuine empty reading, and it must keep behaving like one. An explicit `null`
  // carrier is an absent field, not a wrong-typed one, so it stays on that same road.
  const genuinelyEmptyBodies: [string, unknown][] = [
    ['no credit fields', {}],
    ['an explicitly null config', { config: null }]
  ]

  for (const [label, body] of genuinelyEmptyBodies) {
    it(`still reports a readable billing view with ${label} as unavailable`, async () => {
      netFetchMock.mockResolvedValue(jsonResponse(body))

      await expect(fetchGrokRateLimits()).resolves.toMatchObject({ status: 'unavailable' })
    })
  }

  it('still reports a readable weekly credit reading as a successful one', async () => {
    netFetchMock.mockResolvedValue(jsonResponse({ config: { creditUsagePercent: 41 } }))

    await expect(fetchGrokRateLimits()).resolves.toMatchObject({
      status: 'ok',
      weekly: { usedPercent: 41 }
    })
  })
})
