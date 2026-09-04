import { describe, expect, it } from 'vitest'
import { readClaudeSettingsEffort } from './claude-structured-session-options'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-adapter'
import { acquired, fakeClaude } from './claude-structured-session-test-support'

/** Verbatim from Claude Code 2.1.258's get_settings response. */
const REAL_SETTINGS = {
  applied: { model: 'claude-opus-5[1m]', effort: 'high', advisor: null, ultracode: false },
  effective: { model: 'claude-opus-5[1m]', effortLevel: 'high', env: {} },
  sources: {}
}

describe('Claude effort reporting', () => {
  it('reads the effort get_settings reports', () => {
    expect(readClaudeSettingsEffort(REAL_SETTINGS)).toBe('high')
  })

  it.each([
    [
      'the provider stops reporting it',
      { applied: { effort: 'high' }, effective: {}, sources: {} }
    ],
    ['the payload carries no effective block', { applied: { effort: 'high' } }],
    ['the request failed outright', null]
  ])('reports no effort when %s', (_case, settings) => {
    // Never defaulted: an effort nothing measured would be worse than a blank
    // pill, and this is the assertion that goes red if the key is renamed.
    expect(readClaudeSettingsEffort(settings)).toBeNull()
  })

  it('publishes the effort from get_settings, which system/init never carries', async () => {
    const claude = fakeClaude({ settings: REAL_SETTINGS })
    const adapter = await acquired(claude)

    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      current: { effort: 'high' }
    })
  })

  it('leaves the effort unreported when the session never learns one', async () => {
    const claude = fakeClaude({ settings: { applied: {}, effective: {}, sources: {} } })
    const adapter = await acquired(claude)

    const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(options.current.effort).toBeUndefined()
    expect(options.current.model).toBeTruthy()
  })

  it('keeps the init fixture free of an effort the real frame never sends', async () => {
    const events: ClaudeStructuredSessionEvent[] = []
    await acquired(fakeClaude(), {}, events)
    const init = events.flatMap((event) =>
      event.type === 'message' && event.message.subtype === 'init' ? [event.message] : []
    )

    expect(init).toHaveLength(1)
    expect(init[0]).toHaveProperty('model')
    // The regression that hid this defect: a fixture inventing `effortLevel`
    // kept every gate green over a value that is always empty in production.
    expect(Object.keys(init[0])).not.toContain('effortLevel')
  })
})
