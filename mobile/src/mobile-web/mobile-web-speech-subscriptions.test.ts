import { describe, expect, it, vi } from 'vitest'
import { MobileWebSpeechSubscriptions } from './mobile-web-speech-subscriptions'

describe('MobileWebSpeechSubscriptions', () => {
  it('orders events and drops queued delivery after cancellation', async () => {
    const subscriptions = new MobileWebSpeechSubscriptions()
    let releaseFirst: (() => void) | undefined
    const post = vi.fn((sequence: number) =>
      sequence === 0
        ? new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
        : Promise.resolve()
    )
    subscriptions.start({
      requestId: 'request-1',
      subscriptionId: 'subscription-1',
      post,
      closed: vi.fn()
    })

    subscriptions.post({ status: 'recording' })
    subscriptions.post({ status: 'processing' })
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'))
    expect(subscriptions.cancel('subscription-1')).toBe('request-1')
    releaseFirst?.()

    await Promise.resolve()
    await Promise.resolve()
    expect(post).toHaveBeenCalledOnce()
    expect(post).toHaveBeenCalledWith(0, { status: 'recording' })
  })

  it('tells the page when a delivery failure retires the dictation stream', async () => {
    const subscriptions = new MobileWebSpeechSubscriptions()
    const closed = vi.fn()
    subscriptions.start({
      requestId: 'request-1',
      subscriptionId: 'subscription-1',
      post: () => Promise.reject(new Error('post failed')),
      closed
    })

    subscriptions.post({ status: 'recording' })
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())

    expect(closed).toHaveBeenCalledWith({ code: 'unavailable', retryable: true })
    expect(subscriptions.cancel('subscription-1')).toBeNull()
  })
})
