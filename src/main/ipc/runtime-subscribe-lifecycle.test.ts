import { beforeEach, describe, expect, it, vi } from 'vitest'

type StreamRecord = {
  emit: (response: string) => void
  settled: boolean
  signal: AbortSignal
  subscriptionId: string
}

const { handlers, listeners, streams } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  listeners: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  streams: [] as StreamRecord[]
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      listeners.set(channel, handler)
    }),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn()
  }
}))

vi.mock('../runtime/rpc/dispatcher', () => ({
  RpcDispatcher: class {
    dispatchStreaming(
      request: { id: string },
      emit: (response: string) => void,
      options: { signal: AbortSignal }
    ): Promise<void> {
      const record: StreamRecord = {
        emit,
        settled: false,
        signal: options.signal,
        subscriptionId: request.id
      }
      streams.push(record)
      return new Promise<void>((resolve) => {
        options.signal.addEventListener('abort', () => {
          record.settled = true
          resolve()
        })
      })
    }
  }
}))

import { registerRuntimeHandlers } from './runtime'

type SenderHarness = {
  destroy: () => void
  emitDidNavigate: () => void
  emitRenderProcessGone: () => void
  listenerCount: (eventName: string) => number
  sender: {
    id: number
    isDestroyed: () => boolean
    on: (eventName: string, callback: () => void) => void
    once: (eventName: string, callback: () => void) => void
    send: ReturnType<typeof vi.fn>
  }
}

function createSender(id: number): SenderHarness {
  const senderListeners = new Map<string, (() => void)[]>()
  let destroyed = false
  const add = (eventName: string, callback: () => void): void => {
    const callbacks = senderListeners.get(eventName) ?? []
    callbacks.push(callback)
    senderListeners.set(eventName, callbacks)
  }
  const fire = (eventName: string): void => {
    for (const callback of senderListeners.get(eventName) ?? []) {
      callback()
    }
  }
  return {
    destroy: () => {
      destroyed = true
      fire('destroyed')
    },
    emitDidNavigate: () => fire('did-navigate'),
    emitRenderProcessGone: () => fire('render-process-gone'),
    listenerCount: (eventName) => (senderListeners.get(eventName) ?? []).length,
    sender: {
      id,
      isDestroyed: () => destroyed,
      on: add,
      once: (eventName, callback) => {
        const wrapped = (): void => {
          const callbacks = senderListeners.get(eventName) ?? []
          senderListeners.set(
            eventName,
            callbacks.filter((candidate) => candidate !== wrapped)
          )
          callback()
        }
        add(eventName, wrapped)
      },
      send: vi.fn()
    }
  }
}

function subscribe(sender: SenderHarness['sender'], subscriptionId: string): void {
  const handler = handlers.get('runtime:subscribe')
  if (!handler) {
    throw new Error('runtime:subscribe handler not registered')
  }
  handler({ sender }, { subscriptionId, method: 'agentSession.watch' })
}

function streamFor(subscriptionId: string): StreamRecord {
  const record = streams.findLast((entry) => entry.subscriptionId === subscriptionId)
  if (!record) {
    throw new Error(`no stream dispatched for ${subscriptionId}`)
  }
  return record
}

const FRAME = JSON.stringify({ ok: true, result: { seq: 1 } })

describe('runtime:subscribe renderer lifecycle cleanup', () => {
  beforeEach(() => {
    handlers.clear()
    listeners.clear()
    streams.length = 0
    registerRuntimeHandlers({} as never)
  })

  it('aborts a live stream once its sender commits a navigation', () => {
    const harness = createSender(1)
    subscribe(harness.sender, 'sub-reload')
    const stream = streamFor('sub-reload')

    stream.emit(FRAME)
    expect(harness.sender.send).toHaveBeenCalledTimes(1)
    expect(harness.sender.send).toHaveBeenCalledWith('runtime:subscription:sub-reload', {
      ok: true,
      result: { seq: 1 }
    })

    harness.emitDidNavigate()
    expect(stream.signal.aborted).toBe(true)
    expect(stream.settled).toBe(true)

    stream.emit(FRAME)
    expect(harness.sender.send).toHaveBeenCalledTimes(1)
  })

  it('aborts a live stream when the renderer process dies without destruction', () => {
    const harness = createSender(2)
    subscribe(harness.sender, 'sub-crash')
    const stream = streamFor('sub-crash')

    harness.emitRenderProcessGone()
    expect(stream.signal.aborted).toBe(true)

    stream.emit(FRAME)
    expect(harness.sender.send).not.toHaveBeenCalled()
  })

  it('still aborts on sender destruction', () => {
    const harness = createSender(3)
    subscribe(harness.sender, 'sub-destroyed')
    const stream = streamFor('sub-destroyed')

    harness.destroy()
    expect(stream.signal.aborted).toBe(true)

    stream.emit(FRAME)
    expect(harness.sender.send).not.toHaveBeenCalled()
  })

  it('scopes navigation cleanup to the navigating sender', () => {
    const navigating = createSender(4)
    const surviving = createSender(5)
    subscribe(navigating.sender, 'sub-navigating')
    subscribe(surviving.sender, 'sub-surviving')

    navigating.emitDidNavigate()

    expect(streamFor('sub-navigating').signal.aborted).toBe(true)
    expect(streamFor('sub-surviving').signal.aborted).toBe(false)
    streamFor('sub-surviving').emit(FRAME)
    expect(surviving.sender.send).toHaveBeenCalledTimes(1)
  })

  it('streams to a fresh post-reload subscription while the orphan stays dead', async () => {
    const harness = createSender(6)
    subscribe(harness.sender, 'sub-old')
    const orphan = streamFor('sub-old')

    harness.emitDidNavigate()
    expect(orphan.signal.aborted).toBe(true)
    // The settled stream's cleanup runs off the dispatch promise.
    await Promise.resolve()

    subscribe(harness.sender, 'sub-new')
    const fresh = streamFor('sub-new')
    expect(fresh.signal.aborted).toBe(false)

    fresh.emit(FRAME)
    orphan.emit(FRAME)
    expect(harness.sender.send).toHaveBeenCalledTimes(1)
    expect(harness.sender.send).toHaveBeenCalledWith('runtime:subscription:sub-new', {
      ok: true,
      result: { seq: 1 }
    })

    // Lifecycle listeners are registered once per sender, not once per subscription.
    expect(harness.listenerCount('did-navigate')).toBe(1)
    expect(harness.listenerCount('render-process-gone')).toBe(1)
  })

  it('aborts every stream of a sender with several live subscriptions', () => {
    const harness = createSender(7)
    subscribe(harness.sender, 'sub-a')
    subscribe(harness.sender, 'sub-b')

    harness.emitDidNavigate()

    expect(streamFor('sub-a').signal.aborted).toBe(true)
    expect(streamFor('sub-b').signal.aborted).toBe(true)
  })

  it('keeps explicit unsubscribe working', () => {
    const harness = createSender(8)
    subscribe(harness.sender, 'sub-explicit')
    const stream = streamFor('sub-explicit')

    const unsubscribe = listeners.get('runtime:unsubscribe')
    if (!unsubscribe) {
      throw new Error('runtime:unsubscribe listener not registered')
    }
    unsubscribe({ sender: harness.sender }, { subscriptionId: 'sub-explicit' })

    expect(stream.signal.aborted).toBe(true)
  })

  it('scopes colliding subscription ids and unsubscribe to their sender', () => {
    const firstHarness = createSender(9)
    const secondHarness = createSender(10)
    subscribe(firstHarness.sender, 'sub-collision')
    const first = streams.at(-1)!
    subscribe(secondHarness.sender, 'sub-collision')
    const second = streams.at(-1)!

    expect(first.signal.aborted).toBe(false)
    expect(second.signal.aborted).toBe(false)

    const unsubscribe = listeners.get('runtime:unsubscribe')
    if (!unsubscribe) {
      throw new Error('runtime:unsubscribe listener not registered')
    }
    unsubscribe({ sender: firstHarness.sender }, { subscriptionId: 'sub-collision' })

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
  })
})
