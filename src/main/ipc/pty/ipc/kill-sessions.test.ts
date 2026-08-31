import { describe, expect, it, vi } from 'vitest'
import { MAX_PTY_KILL_SESSION_REFS } from '../../../../shared/pty-kill-sessions'
import { killPtySessions } from './kill-sessions'

describe('killPtySessions input bounds', () => {
  it('returns a per-ref refusal for entries above the bulk request ceiling', async () => {
    const refs = Array.from({ length: MAX_PTY_KILL_SESSION_REFS + 1 }, (_, index) => ({
      id: `session-${index}`,
      incarnationId: `incarnation-${index}`
    }))

    const results = await killPtySessions(refs, 'orphan-cleanup', {
      listProviders: () => [],
      providerForSession: () => undefined,
      isOwned: vi.fn(() => ({ owned: false })),
      shutdown: vi.fn(async () => undefined)
    })

    expect(results).toHaveLength(refs.length)
    expect(results.at(-1)).toEqual({
      ...refs.at(-1),
      verdict: 'refused',
      reason: 'kill request exceeded the maximum batch size'
    })
  })
})
