import { describe, expect, it, vi } from 'vitest'
import {
  SLEEPING_PANE_WAKE_QUEUE_LIMIT,
  SLEEPING_PANE_WAKE_SPACING_MS,
  SLEEPING_PANE_WAKE_SUPPRESSION_TTL_MS,
  SleepingPaneWakeScheduler,
  type SleepingPaneWakeRequest
} from './sleeping-pane-wake-scheduler'

type Timer = { run: () => void; delayMs: number }

function harness(options: { wake?: (request: SleepingPaneWakeRequest) => void } = {}) {
  let now = 1_000_000
  const woken: SleepingPaneWakeRequest[] = []
  const timers: Timer[] = []
  const scheduler = new SleepingPaneWakeScheduler({
    wake: (request) => {
      woken.push(request)
      options.wake?.(request)
    },
    now: () => now,
    schedule: (run, delayMs) => {
      timers.push({ run, delayMs })
      return timers.length as unknown as ReturnType<typeof setTimeout>
    },
    cancel: () => undefined
  })
  return {
    scheduler,
    woken,
    timers,
    advance: (ms: number) => {
      now += ms
    },
    fireTimers: () => {
      const pending = timers.splice(0)
      for (const timer of pending) {
        timer.run()
      }
    }
  }
}

function paneRequest(paneKey: string): SleepingPaneWakeRequest {
  return { paneKey, worktreeId: 'wt-1', tabId: `tab-${paneKey}` }
}

describe('SleepingPaneWakeScheduler', () => {
  it('wakes the first request immediately', () => {
    const h = harness()
    expect(h.scheduler.request(paneRequest('a'))).toBe('requested')
    expect(h.woken).toEqual([paneRequest('a')])
  })

  it('suppresses a repeat wake for the same pane inside the TTL', () => {
    const h = harness()
    h.scheduler.request(paneRequest('a'))
    h.advance(SLEEPING_PANE_WAKE_SUPPRESSION_TTL_MS - 1)
    expect(h.scheduler.request(paneRequest('a'))).toBe('suppressed')
    expect(h.woken).toHaveLength(1)
  })

  it('allows the pane again once the TTL lapses', () => {
    const h = harness()
    h.scheduler.request(paneRequest('a'))
    h.advance(SLEEPING_PANE_WAKE_SUPPRESSION_TTL_MS)
    expect(h.scheduler.request(paneRequest('a'))).toBe('requested')
    expect(h.woken).toHaveLength(2)
  })

  it('does not retry a wake that threw', () => {
    const h = harness({
      wake: () => {
        throw new Error('no authoritative window')
      }
    })
    expect(() => h.scheduler.request(paneRequest('a'))).not.toThrow()
    expect(h.scheduler.request(paneRequest('a'))).toBe('suppressed')
  })

  it('spreads a broadcast instead of waking every pane at once', () => {
    const h = harness()
    expect(h.scheduler.request(paneRequest('a'))).toBe('requested')
    expect(h.scheduler.request(paneRequest('b'))).toBe('queued')
    expect(h.scheduler.request(paneRequest('c'))).toBe('queued')
    expect(h.woken.map((request) => request.paneKey)).toEqual(['a'])

    h.advance(SLEEPING_PANE_WAKE_SPACING_MS)
    h.fireTimers()
    expect(h.woken.map((request) => request.paneKey)).toEqual(['a', 'b'])

    h.advance(SLEEPING_PANE_WAKE_SPACING_MS)
    h.fireTimers()
    expect(h.woken.map((request) => request.paneKey)).toEqual(['a', 'b', 'c'])
    expect(h.timers).toHaveLength(0)
  })

  it('queues each pane once', () => {
    const h = harness()
    h.scheduler.request(paneRequest('a'))
    expect(h.scheduler.request(paneRequest('b'))).toBe('queued')
    expect(h.scheduler.request(paneRequest('b'))).toBe('suppressed')
    h.advance(SLEEPING_PANE_WAKE_SPACING_MS)
    h.fireTimers()
    expect(h.woken.map((request) => request.paneKey)).toEqual(['a', 'b'])
  })

  it('drops overflow past the queue limit rather than growing without bound', () => {
    const h = harness()
    h.scheduler.request(paneRequest('head'))
    for (let i = 0; i < SLEEPING_PANE_WAKE_QUEUE_LIMIT; i += 1) {
      expect(h.scheduler.request(paneRequest(`pane-${i}`))).toBe('queued')
    }
    expect(h.scheduler.request(paneRequest('overflow'))).toBe('dropped')
  })

  it('stops scheduling after dispose', () => {
    const h = harness()
    h.scheduler.request(paneRequest('a'))
    h.scheduler.request(paneRequest('b'))
    h.scheduler.dispose()
    h.advance(SLEEPING_PANE_WAKE_SPACING_MS)
    h.fireTimers()
    expect(h.woken.map((request) => request.paneKey)).toEqual(['a'])
  })

  it('defaults to real timers when none are injected', () => {
    vi.useFakeTimers()
    try {
      const woken: string[] = []
      const scheduler = new SleepingPaneWakeScheduler({
        wake: (request) => woken.push(request.paneKey)
      })
      scheduler.request(paneRequest('a'))
      scheduler.request(paneRequest('b'))
      expect(woken).toEqual(['a'])
      vi.advanceTimersByTime(SLEEPING_PANE_WAKE_SPACING_MS)
      expect(woken).toEqual(['a', 'b'])
      scheduler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
