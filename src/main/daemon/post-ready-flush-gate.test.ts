import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PostReadyFlushGate,
  POST_READY_FLUSH_DELAY_MS,
  POST_READY_FLUSH_FALLBACK_MS
} from './post-ready-flush-gate'

describe('PostReadyFlushGate', () => {
  let onFlush: ReturnType<typeof vi.fn<() => void>>
  let gate: PostReadyFlushGate

  beforeEach(() => {
    vi.useFakeTimers()
    onFlush = vi.fn<() => void>()
    gate = new PostReadyFlushGate(onFlush)
  })

  afterEach(() => {
    gate.clear()
    vi.useRealTimers()
  })

  it('waits while a slow prompt still has cooked echo enabled', async () => {
    const probe = vi.fn().mockResolvedValue('other')
    gate = new PostReadyFlushGate(onFlush, probe)
    gate.arm(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onFlush).not.toHaveBeenCalled()
    expect(gate.isPending).toBe(true)
    probe.mockResolvedValue('line-editor')
    await vi.advanceTimersByTimeAsync(250)
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(gate.isPending).toBe(false)
  })

  it('drops an in-flight probe result after teardown', async () => {
    let resolveProbe!: (state: 'line-editor') => void
    gate = new PostReadyFlushGate(
      onFlush,
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve
        })
    )
    gate.arm(true)
    await vi.advanceTimersByTimeAsync(POST_READY_FLUSH_DELAY_MS)
    gate.clear()
    resolveProbe('line-editor')
    await vi.advanceTimersByTimeAsync(1000)
    expect(onFlush).not.toHaveBeenCalled()
    expect(gate.isPending).toBe(false)
  })

  it.each(['unknown', 'unavailable'])('retains the fallback when probing is %s', async (state) => {
    gate = new PostReadyFlushGate(onFlush, vi.fn().mockResolvedValue(state))
    gate.arm()
    await vi.advanceTimersByTimeAsync(POST_READY_FLUSH_FALLBACK_MS)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('bounds waiting when a shell never enters its line editor', async () => {
    gate = new PostReadyFlushGate(onFlush, vi.fn().mockResolvedValue('other'))
    gate.arm(true)
    await vi.advanceTimersByTimeAsync(15_500)
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(gate.isPending).toBe(false)
  })

  it('does not flush immediately when armed', () => {
    gate.arm()
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('flushes via short delay after notifyData signals the prompt draw', () => {
    gate.arm()
    gate.notifyData()
    expect(onFlush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(POST_READY_FLUSH_DELAY_MS)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('flushes via short delay when arm receives post-marker bytes evidence', () => {
    gate.arm(true)
    vi.advanceTimersByTime(POST_READY_FLUSH_DELAY_MS - 1)
    expect(onFlush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('flushes via wall-clock fallback when no notifyData arrives', () => {
    gate.arm()

    vi.advanceTimersByTime(POST_READY_FLUSH_FALLBACK_MS)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('does not fallback at the old duplicate-echo race window', () => {
    gate.arm()

    vi.advanceTimersByTime(50)

    expect(onFlush).not.toHaveBeenCalled()
  })

  it('ignores notifyData before arm()', () => {
    gate.notifyData()
    vi.advanceTimersByTime(1000)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('notifyData after the fallback fired is a no-op', () => {
    gate.arm()
    vi.advanceTimersByTime(POST_READY_FLUSH_FALLBACK_MS)
    expect(onFlush).toHaveBeenCalledTimes(1)

    gate.notifyData()
    vi.advanceTimersByTime(1000)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('only the first notifyData schedules the short-delay flush', () => {
    gate.arm()
    gate.notifyData()
    gate.notifyData()
    gate.notifyData()

    vi.advanceTimersByTime(POST_READY_FLUSH_DELAY_MS)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('clear() cancels a pending fallback flush', () => {
    gate.arm()
    gate.clear()

    vi.advanceTimersByTime(POST_READY_FLUSH_FALLBACK_MS * 2)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('clear() cancels a pending post-data flush', () => {
    gate.arm()
    gate.notifyData()
    gate.clear()

    vi.advanceTimersByTime(POST_READY_FLUSH_DELAY_MS * 2)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('isPending is true throughout the gate window and false once flush fires', () => {
    expect(gate.isPending).toBe(false)
    gate.arm()
    expect(gate.isPending).toBe(true)
    gate.notifyData()
    expect(gate.isPending).toBe(true)
    vi.advanceTimersByTime(POST_READY_FLUSH_DELAY_MS)
    expect(gate.isPending).toBe(false)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })
})
