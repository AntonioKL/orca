import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SSH_MUX_REQUEST_TIMEOUT_CODE,
  SshChannelMultiplexer,
  type MultiplexerTransport
} from './ssh-channel-multiplexer'
import {
  SSH_RELAY_WRITER_FLUSH_TIMEOUT_MS,
  SSH_RELAY_REQUEST_TIMEOUT_MS,
  sshRelayQueueWaitMs,
  sshRelayRequestWorstCaseMs
} from '../../shared/ssh-relay-request-budget'
import { encodeFrame, HEADER_LENGTH, MessageType } from './relay-protocol'

type SaturatingTransport = MultiplexerTransport & {
  deliver: (data: Buffer) => void
  drain: () => void
  close: () => void
  setAccepting: (accepting: boolean) => void
  written: Buffer[]
}

function createTransport(): SaturatingTransport {
  let deliver = (_data: Buffer): void => {}
  let drain = (): void => {}
  let close = (): void => {}
  let accepting = true
  const written: Buffer[] = []
  return {
    write: (data) => {
      written.push(data)
      return accepting
    },
    onDrain: (callback) => {
      drain = callback
    },
    onData: (callback) => {
      deliver = callback
    },
    onClose: (callback) => {
      close = callback
    },
    deliver: (data) => deliver(data),
    drain: () => drain(),
    close: () => close(),
    setAccepting: (value) => {
      accepting = value
    },
    written
  }
}

function writtenMethods(transport: SaturatingTransport): string[] {
  return transport.written.flatMap((frame) => {
    if (frame[0] !== MessageType.Regular) {
      return []
    }
    const length = frame.readUInt32BE(9)
    const payload = JSON.parse(
      frame.subarray(HEADER_LENGTH, HEADER_LENGTH + length).toString()
    ) as { method?: string }
    return payload.method ? [payload.method] : []
  })
}

function track(promise: Promise<unknown>): { settled: () => boolean; error: () => unknown } {
  let outcome: { error: unknown } | { value: unknown } | null = null
  promise.then(
    (value) => {
      outcome = { value }
    },
    (error) => {
      outcome = { error }
    }
  )
  return {
    settled: () => outcome !== null,
    error: () => (outcome && 'error' in outcome ? outcome.error : undefined)
  }
}

// Why: shorter than TIMEOUT_MS so a running deadline fires before the dead-link
// check the tests deliberately leave un-fed.
const REQUEST_BUDGET_MS = 15_000
// Why: real callers run well past the flush window (space scan, native deps).
const LONG_BUDGET_MS = 130_000

async function flush(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await Promise.resolve()
  }
}

describe('SshChannelMultiplexer request deadlines under writer saturation', () => {
  let transport: SaturatingTransport
  let mux: SshChannelMultiplexer

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    transport = createTransport()
    mux = new SshChannelMultiplexer(transport)
  })

  afterEach(() => {
    mux.dispose()
    vi.useRealTimers()
  })

  async function saturate(): Promise<void> {
    transport.setAccepting(false)
    mux.notify('pty.data', { id: 'pty-1', data: 'x' })
    await Promise.resolve()
  }

  it('does not charge the response budget to a request still parked in the writer', async () => {
    await saturate()

    const spawn = mux.request(
      'pty.spawn',
      { command: 'bash' },
      { timeoutMs: REQUEST_BUDGET_MS, budgetStartsAtWire: true }
    )
    const state = track(spawn)
    // The spawn frame never reached the transport, so its budget must not run.
    expect(writtenMethods(transport)).not.toContain('pty.spawn')

    vi.advanceTimersByTime(REQUEST_BUDGET_MS + 1_000)
    await flush()

    expect(mux.isDisposed()).toBe(false)
    expect(state.settled()).toBe(false)

    transport.setAccepting(true)
    transport.drain()
    await Promise.resolve()
    expect(writtenMethods(transport)).toContain('pty.spawn')

    transport.deliver(
      encodeFrame(
        MessageType.Regular,
        1,
        0,
        Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: 'pty-remote' } }))
      )
    )
    await expect(spawn).resolves.toEqual({ id: 'pty-remote' })
  })

  it('starts the response budget when the frame reaches the wire', async () => {
    await saturate()
    const spawn = mux.request(
      'pty.spawn',
      {},
      { timeoutMs: REQUEST_BUDGET_MS, budgetStartsAtWire: true }
    )
    const state = track(spawn)

    vi.advanceTimersByTime(SSH_RELAY_WRITER_FLUSH_TIMEOUT_MS - 1_000)
    transport.setAccepting(true)
    transport.drain()
    await Promise.resolve()

    vi.advanceTimersByTime(REQUEST_BUDGET_MS - 1)
    await flush()
    expect(state.settled()).toBe(false)

    vi.advanceTimersByTime(1)
    await expect(spawn).rejects.toMatchObject({ code: SSH_MUX_REQUEST_TIMEOUT_CODE })
  })

  it('charges only the post-flush budget to a request that saturated the writer itself', async () => {
    transport.setAccepting(false)
    const spawn = mux.request(
      'pty.spawn',
      {},
      { timeoutMs: REQUEST_BUDGET_MS, budgetStartsAtWire: true }
    )
    const state = track(spawn)

    vi.advanceTimersByTime(REQUEST_BUDGET_MS)
    await flush()
    expect(state.settled()).toBe(false)

    transport.setAccepting(true)
    transport.drain()
    await Promise.resolve()

    vi.advanceTimersByTime(REQUEST_BUDGET_MS)
    await expect(spawn).rejects.toMatchObject({ code: SSH_MUX_REQUEST_TIMEOUT_CODE })
  })

  it('bounds the flush wait so a writer that never drains still times out', async () => {
    await saturate()
    const spawn = mux.request(
      'pty.spawn',
      {},
      { timeoutMs: REQUEST_BUDGET_MS, budgetStartsAtWire: true }
    )
    const state = track(spawn)

    vi.advanceTimersByTime(SSH_RELAY_WRITER_FLUSH_TIMEOUT_MS - 1)
    await flush()
    expect(state.settled()).toBe(false)

    vi.advanceTimersByTime(1)
    await expect(spawn).rejects.toMatchObject({
      code: SSH_MUX_REQUEST_TIMEOUT_CODE,
      message: `Request "pty.spawn" timed out after ${SSH_RELAY_WRITER_FLUSH_TIMEOUT_MS}ms without reaching the wire`
    })
  })

  // Why: teardown threads an absolute sweep deadline through timeoutMs, so that
  // call must settle inside it rather than buy a flush window on top — the
  // default, so no teardown call site has to know about the writer.
  it('charges the queue wait to a request that did not opt in', async () => {
    await saturate()
    const shutdown = mux.request('pty.shutdown', {}, { timeoutMs: REQUEST_BUDGET_MS })
    const state = track(shutdown)

    vi.advanceTimersByTime(REQUEST_BUDGET_MS - 1)
    await flush()
    expect(state.settled()).toBe(false)

    vi.advanceTimersByTime(1)
    await expect(shutdown).rejects.toMatchObject({
      code: SSH_MUX_REQUEST_TIMEOUT_CODE,
      message: `Request "pty.shutdown" timed out after ${REQUEST_BUDGET_MS}ms`
    })
  })

  // Why: opting in must never shorten a call. A 130s scan or native-deps install
  // parked past the flush window would otherwise fail at 30s during exactly the
  // deploy congestion the wire-started budget exists for.
  it('never bounds the queue wait below the caller budget', async () => {
    await saturate()
    const scan = mux.request(
      'fs.spaceScan',
      {},
      { timeoutMs: LONG_BUDGET_MS, budgetStartsAtWire: true }
    )
    const state = track(scan)

    vi.advanceTimersByTime(SSH_RELAY_WRITER_FLUSH_TIMEOUT_MS + 15_000)
    await flush()
    expect(state.settled()).toBe(false)

    transport.setAccepting(true)
    transport.drain()
    await Promise.resolve()
    expect(writtenMethods(transport)).toContain('fs.spaceScan')
  })

  // Why: the pane-connect backstops are sized from sshRelayRequestWorstCaseMs, so
  // the wait the mux enforces has to be the one that function advertises — a
  // fixed 60s worst case would understate this caller by 200s.
  it('bounds the queue wait at the advertised wait for a long caller budget', async () => {
    await saturate()
    const scan = mux.request(
      'fs.spaceScan',
      {},
      { timeoutMs: LONG_BUDGET_MS, budgetStartsAtWire: true }
    )
    const state = track(scan)
    const queueWaitMs = sshRelayQueueWaitMs(LONG_BUDGET_MS)
    expect(sshRelayRequestWorstCaseMs(LONG_BUDGET_MS)).toBe(queueWaitMs + LONG_BUDGET_MS)

    vi.advanceTimersByTime(queueWaitMs - 1)
    await flush()
    expect(mux.isDisposed()).toBe(false)
    expect(state.settled()).toBe(false)

    vi.advanceTimersByTime(1)
    await expect(scan).rejects.toMatchObject({
      code: SSH_MUX_REQUEST_TIMEOUT_CODE,
      message: `Request "fs.spaceScan" timed out after ${queueWaitMs}ms without reaching the wire`
    })
  })

  // Why: pty.getSize picks a 1s budget so wake repair re-forwards fast; a flush
  // window it never asked for would defer resize repair by half a minute.
  it('keeps a short fail-fast budget for a request that did not opt in', async () => {
    await saturate()
    const size = mux.request('pty.getSize', {}, { timeoutMs: 1_000 })
    const state = track(size)

    vi.advanceTimersByTime(999)
    await flush()
    expect(state.settled()).toBe(false)

    vi.advanceTimersByTime(1)
    await expect(size).rejects.toMatchObject({
      code: SSH_MUX_REQUEST_TIMEOUT_CODE,
      message: 'Request "pty.getSize" timed out after 1000ms'
    })
  })

  // Why: sustained pty.data flaps the writer between saturated and drained; a
  // grace re-armed per episode would suspend this deadline forever (#G5).
  it('times out a request already on the wire while saturation flaps', async () => {
    const status = mux.request('git.status', {}, { timeoutMs: REQUEST_BUDGET_MS })
    const state = track(status)
    expect(writtenMethods(transport)).toContain('git.status')

    for (let cycle = 0; cycle < 3; cycle += 1) {
      transport.setAccepting(false)
      mux.notify('pty.data', { id: 'pty-1', data: 'x' })
      await Promise.resolve()
      vi.advanceTimersByTime(REQUEST_BUDGET_MS / 3)
      transport.setAccepting(true)
      transport.drain()
      await Promise.resolve()
    }
    await flush()

    expect(state.settled()).toBe(true)
    expect(state.error()).toMatchObject({ code: SSH_MUX_REQUEST_TIMEOUT_CODE })
  })

  it('still fails a parked request when the link is genuinely lost', async () => {
    await saturate()
    const spawn = mux.request(
      'pty.spawn',
      {},
      { timeoutMs: REQUEST_BUDGET_MS, budgetStartsAtWire: true }
    )

    vi.advanceTimersByTime(SSH_RELAY_WRITER_FLUSH_TIMEOUT_MS / 2)
    transport.close()

    await expect(spawn).rejects.toMatchObject({ code: 'CONNECTION_LOST' })
    expect(mux.isDisposed()).toBe(true)
  })

  it('leaves dead-link detection on an unsaturated writer unchanged', async () => {
    const spawn = mux.request('pty.spawn', {}, { timeoutMs: SSH_RELAY_REQUEST_TIMEOUT_MS })
    const state = track(spawn)

    vi.advanceTimersByTime(25_000)
    await flush()

    expect(mux.isDisposed()).toBe(true)
    expect(state.error()).toMatchObject({ code: 'CONNECTION_LOST' })
  })
})
