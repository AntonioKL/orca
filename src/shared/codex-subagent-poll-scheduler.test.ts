import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodexSubagentPollScheduler } from './codex-subagent-poll-scheduler'

describe('CodexSubagentPollScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms one timer and preserves registration order for simultaneous panes', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const scheduler = new CodexSubagentPollScheduler(1_000, (key) => {
      seen.push(key)
    })

    scheduler.schedule('pane-a', undefined)
    scheduler.schedule('pane-b', undefined)
    scheduler.schedule('pane-c', undefined)

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(999)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)

    expect(seen).toEqual(['pane-a', 'pane-b', 'pane-c'])
    expect(scheduler.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps staggered deadlines and cancellation independent', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const scheduler = new CodexSubagentPollScheduler(1_000, (key) => {
      seen.push(key)
    })

    scheduler.schedule('pane-a', undefined)
    vi.advanceTimersByTime(500)
    scheduler.schedule('pane-b', undefined)
    scheduler.clear('pane-a')

    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(999)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual(['pane-b'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets a due callback cancel a sibling before that sibling runs', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    let scheduler!: CodexSubagentPollScheduler<undefined>
    scheduler = new CodexSubagentPollScheduler(1_000, (key) => {
      seen.push(key)
      if (key === 'pane-a') {
        scheduler.clear('pane-b')
      }
    })

    scheduler.schedule('pane-a', undefined)
    scheduler.schedule('pane-b', undefined)
    vi.advanceTimersByTime(1_000)

    expect(seen).toEqual(['pane-a'])
    expect(scheduler.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
