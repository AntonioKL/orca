import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  readCodexRateLimitsViaRpc,
  type CodexRpcRateLimitChild
} from './codex-rpc-rate-limit-probe'

function makeRpcChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn> }
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn() })
  return child
}

function readRateLimits(result: unknown): Promise<{ status: string; error: string | null }> {
  const child = makeRpcChild()
  child.stdin.write.mockImplementation((line: string) => {
    const msg = JSON.parse(line) as { id?: number; method?: string }
    if (msg.method === 'initialize') {
      setTimeout(() => {
        child.stdout.emit(
          'data',
          Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`)
        )
      }, 0)
    }
    if (msg.method === 'account/rateLimits/read') {
      setTimeout(() => {
        child.stdout.emit(
          'data',
          Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)
        )
      }, 0)
    }
  })
  return readCodexRateLimitsViaRpc({
    child: child as unknown as CodexRpcRateLimitChild,
    codexCommand: 'codex',
    initTimeoutMs: 1_000,
    rpcTimeoutMs: 1_000,
    terminate: () => Promise.resolve()
  })
}

// STA-3445: `message.result` arrives from JSON.parse as `unknown` and was cast
// straight to the expected wrapper. Every unreadable shape then classified into
// two null windows and settled as a successful, empty reading — which the stale
// policy treats as fresh data and writes over the last real snapshot.
describe('readCodexRateLimitsViaRpc with an unreadable result', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it.each([
    ['no result and no error', undefined],
    ['a null result', null],
    ['a scalar result', 42],
    ['an array result', []],
    ['a scalar rateLimits field', { rateLimits: 42 }],
    ['an array rateLimits field', { rateLimits: [] }],
    ['a scalar primary window', { rateLimits: { primary: 42 } }],
    ['a primary window without usage', { rateLimits: { primary: {} } }],
    ['a primary window with non-numeric usage', { rateLimits: { primary: { usedPercent: '5' } } }]
  ])('does not report %s as a successful empty reading', async (_label, result) => {
    const pending = readRateLimits(result)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(pending).resolves.toMatchObject({
      provider: 'codex',
      session: null,
      weekly: null,
      status: 'error',
      error: 'Codex returned an unreadable usage response'
    })
  })

  it.each([
    ['an empty object', {}],
    ['an explicit null rateLimits', { rateLimits: null }]
  ])('still accepts %s as a real answer with no windows', async (_label, result) => {
    const pending = readRateLimits(result)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(pending).resolves.toMatchObject({
      provider: 'codex',
      session: null,
      weekly: null,
      status: 'ok',
      error: null
    })
  })
})
