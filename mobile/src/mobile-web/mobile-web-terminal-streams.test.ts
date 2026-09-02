import { Buffer } from 'buffer/'
import { describe, expect, it, vi } from 'vitest'
import type { MobileWebTerminalEvent } from '../../../src/shared/mobile-web/terminal-stream-contract'
import type { RpcClient } from '../transport/rpc-client'
import {
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamJson,
  encodeTerminalStreamText,
  TerminalStreamOpcode,
  type TerminalStreamFrame
} from '../transport/terminal-stream-protocol'
import { MobileWebTerminalStreams } from './mobile-web-terminal-streams'
import {
  prepareMobileWebClipboardPaste,
  prepareMobileWebImageAttachment
} from './mobile-web-terminal-device-input-authority'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

vi.mock('./mobile-web-terminal-device-input-authority', () => ({
  prepareMobileWebClipboardPaste: vi.fn(),
  prepareMobileWebImageAttachment: vi.fn()
}))

const SUBSCRIPTION_ID = 'S'.repeat(22)
const HOST_WORKSPACE_ID = 'repo::/secret/worktree'
const PAGE_WORKSPACE_ID = `workspace_0_${'09'.repeat(16)}`
const OSC_LINKS = [{ row: 0, startCol: 0, endCol: 7, uri: 'https://example.com/issue/1' }]

describe('MobileWebTerminalStreams', () => {
  it('keeps the host handle native-only and translates snapshot, output, and ACK frames', async () => {
    const harness = createHarness()
    await harness.streams.start({
      requestId: 'request-1',
      subscriptionId: SUBSCRIPTION_ID,
      payload: subscribePayload(),
      client: harness.client,
      isRequestActive: () => true
    })

    harness.emitMultiplex({ type: 'ready' })
    const subscribe = harness.sentFrames.find(
      (frame) => frame.opcode === TerminalStreamOpcode.Subscribe
    )
    expect(subscribe?.streamId).toBe(0)
    const hostRequest = decodeTerminalStreamJson<Record<string, unknown>>(subscribe!.payload)
    expect(hostRequest).toMatchObject({
      terminal: 'terminal-secret',
      client: { id: 'device-secret', type: 'mobile' },
      capabilities: { ackOutput: 1, queryReply: 1 }
    })
    expect(harness.sendRequest).toHaveBeenCalledWith('session.tabs.list', {
      worktree: `id:${HOST_WORKSPACE_ID}`
    })
    const hostStreamId = hostRequest!.streamId as number

    harness.emitMultiplex({
      type: 'subscribed',
      streamId: hostStreamId,
      terminal: 'terminal-secret'
    })
    harness.emitFrame({
      opcode: TerminalStreamOpcode.SnapshotStart,
      streamId: hostStreamId,
      seq: 0,
      payload: encodeTerminalStreamJson({
        kind: 'scrollback',
        cols: 80,
        rows: 24,
        cwd: '/secret/worktree',
        source: 'renderer',
        oscLinks: OSC_LINKS
      })
    })
    harness.emitFrame({
      opcode: TerminalStreamOpcode.SnapshotChunk,
      streamId: hostStreamId,
      seq: 1,
      payload: encodeTerminalStreamText('prompt$ ')
    })
    harness.emitFrame({
      opcode: TerminalStreamOpcode.SnapshotEnd,
      streamId: hostStreamId,
      seq: 2,
      payload: new Uint8Array()
    })
    const outputPayload = encodeTerminalStreamText('hello λ')
    harness.emitFrame({
      opcode: TerminalStreamOpcode.Output,
      streamId: hostStreamId,
      seq: 3,
      payload: outputPayload
    })
    await settle()

    expect(JSON.stringify(harness.events)).not.toContain('terminal-secret')
    expect(JSON.stringify(harness.events)).not.toContain('/secret/worktree')
    expect(harness.events.map(({ event }) => event.type)).toEqual([
      'subscribed',
      'snapshotStart',
      'snapshotChunk',
      'snapshotEnd',
      'output'
    ])
    expect(harness.events[1]?.event).toMatchObject({
      type: 'snapshotStart',
      snapshotId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      oscLinks: OSC_LINKS
    })
    const output = harness.events.at(-1)!.event
    expect(output).toMatchObject({
      type: 'output',
      streamId: SUBSCRIPTION_ID,
      startSequence: 0,
      endSequence: outputPayload.byteLength,
      data: Buffer.from(outputPayload).toString('base64')
    })
    expect(harness.flowMetrics.at(-1)).toEqual({
      ackLagMs: undefined,
      outstandingBytes: outputPayload.byteLength
    })

    harness.advanceTime(47)
    await harness.streams.handle(
      {
        operation: 'ack',
        streamId: SUBSCRIPTION_ID,
        throughSequence: outputPayload.byteLength
      },
      harness.client
    )
    const ack = harness.sentFrames.at(-1)!
    expect(ack.opcode).toBe(TerminalStreamOpcode.Ack)
    expect(decodeTerminalStreamJson(ack.payload)).toEqual({ bytes: outputPayload.byteLength })
    expect(harness.flowMetrics.at(-1)).toEqual({ ackLagMs: 47, outstandingBytes: 0 })
  })

  it('rejects out-of-order input and releases the native stream on cancellation', async () => {
    const harness = createHarness()
    await harness.streams.start({
      requestId: 'request-2',
      subscriptionId: SUBSCRIPTION_ID,
      payload: subscribePayload(),
      client: harness.client,
      isRequestActive: () => true
    })
    harness.emitMultiplex({ type: 'ready' })
    const subscribe = harness.sentFrames.at(-1)!
    const hostStreamId = decodeTerminalStreamJson<Record<string, unknown>>(subscribe.payload)!
      .streamId as number
    harness.emitMultiplex({ type: 'subscribed', streamId: hostStreamId })

    expect(() =>
      harness.streams.handle(
        {
          operation: 'input',
          streamId: SUBSCRIPTION_ID,
          sequence: 1,
          data: Buffer.from('x').toString('base64')
        },
        harness.client
      )
    ).toThrow('conflict')

    expect(harness.streams.cancel(SUBSCRIPTION_ID, harness.client)).toBe('request-2')
    expect(harness.sentFrames.at(-1)).toMatchObject({
      opcode: TerminalStreamOpcode.Unsubscribe,
      streamId: hostStreamId
    })
  })

  it('records page, invalid-snapshot, and overflow resync reasons without identifiers', async () => {
    const harness = createHarness()
    await harness.streams.start({
      requestId: 'request-resync',
      subscriptionId: SUBSCRIPTION_ID,
      payload: subscribePayload(),
      client: harness.client,
      isRequestActive: () => true
    })
    harness.emitMultiplex({ type: 'ready' })
    const hostStreamId = decodeTerminalStreamJson<Record<string, unknown>>(
      harness.sentFrames.at(-1)!.payload
    )!.streamId as number
    harness.emitMultiplex({ type: 'subscribed', streamId: hostStreamId })

    await harness.streams.handle(
      {
        operation: 'resync',
        streamId: SUBSCRIPTION_ID,
        fromSequence: 0,
        reason: 'gap'
      },
      harness.client
    )
    harness.emitFrame({
      opcode: TerminalStreamOpcode.SnapshotStart,
      streamId: hostStreamId,
      seq: 0,
      payload: encodeTerminalStreamJson({
        kind: 'scrollback',
        cols: 80,
        rows: 24,
        oscLinks: [{ row: -1, startCol: 0, endCol: 1, uri: 'file:///invalid' }]
      })
    })
    harness.emitFrame({
      opcode: TerminalStreamOpcode.SnapshotChunk,
      streamId: hostStreamId,
      seq: 1,
      payload: encodeTerminalStreamText('invalid')
    })
    harness.emitFrame({
      opcode: TerminalStreamOpcode.Output,
      streamId: hostStreamId,
      seq: 2,
      payload: new Uint8Array(256 * 1024 + 1)
    })

    expect(harness.resyncReasons).toEqual(['gap', 'snapshot-invalid', 'flow-overflow'])
    expect(harness.sentFrames.at(-1)?.opcode).toBe(TerminalStreamOpcode.SnapshotRequest)
    expect(JSON.stringify(harness.resyncReasons)).not.toContain(HOST_WORKSPACE_ID)
    expect(JSON.stringify(harness.resyncReasons)).not.toContain('terminal-secret')
  })

  it('uses the query-reply opcode only after the host echoes support', async () => {
    const harness = createHarness()
    await harness.streams.start({
      requestId: 'request-query',
      subscriptionId: SUBSCRIPTION_ID,
      payload: subscribePayload(),
      client: harness.client,
      isRequestActive: () => true
    })
    harness.emitMultiplex({ type: 'ready' })
    const subscribe = harness.sentFrames.at(-1)!
    const hostStreamId = decodeTerminalStreamJson<Record<string, unknown>>(subscribe.payload)!
      .streamId as number
    harness.emitMultiplex({
      type: 'subscribed',
      streamId: hostStreamId,
      capabilities: { queryReply: 1 }
    })

    await harness.streams.handle(
      {
        operation: 'input',
        streamId: SUBSCRIPTION_ID,
        sequence: 0,
        data: Buffer.from('x').toString('base64')
      },
      harness.client
    )
    await harness.streams.handle(
      {
        operation: 'queryReply',
        streamId: SUBSCRIPTION_ID,
        sequence: 1,
        data: Buffer.from('\x1b[0n').toString('base64')
      },
      harness.client
    )

    expect(harness.sentFrames.slice(-2).map((frame) => frame.opcode)).toEqual([
      TerminalStreamOpcode.Input,
      TerminalStreamOpcode.QueryReply
    ])
    expect(decodeTerminalStreamText(harness.sentFrames.at(-1)!.payload)).toBe('\x1b[0n')
  })

  it('falls back to legacy input when an older host omits query-reply support', async () => {
    const harness = createHarness()
    await harness.streams.start({
      requestId: 'request-legacy-query',
      subscriptionId: SUBSCRIPTION_ID,
      payload: subscribePayload(),
      client: harness.client,
      isRequestActive: () => true
    })
    harness.emitMultiplex({ type: 'ready' })
    const subscribe = harness.sentFrames.at(-1)!
    const hostStreamId = decodeTerminalStreamJson<Record<string, unknown>>(subscribe.payload)!
      .streamId as number
    harness.emitMultiplex({ type: 'subscribed', streamId: hostStreamId })

    await harness.streams.handle(
      {
        operation: 'queryReply',
        streamId: SUBSCRIPTION_ID,
        sequence: 0,
        data: Buffer.from('\x1b[0n').toString('base64')
      },
      harness.client
    )

    expect(harness.sentFrames.at(-1)?.opcode).toBe(TerminalStreamOpcode.Input)
    expect(decodeTerminalStreamText(harness.sentFrames.at(-1)!.payload)).toBe('\x1b[0n')
  })

  it('keeps shell-owned device input native and returns status without native paths', async () => {
    const harness = createHarness()
    await harness.streams.start({
      requestId: 'request-device-input',
      subscriptionId: SUBSCRIPTION_ID,
      payload: subscribePayload(),
      client: harness.client,
      isRequestActive: () => true
    })
    harness.emitMultiplex({ type: 'ready' })
    const subscribe = harness.sentFrames.at(-1)!
    const hostStreamId = decodeTerminalStreamJson<Record<string, unknown>>(subscribe.payload)!
      .streamId as number
    harness.emitMultiplex({ type: 'subscribed', streamId: hostStreamId })
    vi.mocked(prepareMobileWebClipboardPaste).mockResolvedValue({
      status: 'accepted',
      payload: '\u001b[200~/native/secret/image.png\u001b[201~'
    })

    await expect(
      harness.streams.handle(
        {
          operation: 'clipboardPaste',
          streamId: SUBSCRIPTION_ID,
          sequence: 0,
          bracketedPaste: true
        },
        harness.client
      )
    ).resolves.toEqual({ status: 'accepted' })
    expect(decodeTerminalStreamText(harness.sentFrames.at(-1)!.payload)).toContain(
      '/native/secret/image.png'
    )
    expect(prepareMobileWebImageAttachment).not.toHaveBeenCalled()
  })

  it('maps display mode, rename, and clear to the resolved native terminal only', async () => {
    const harness = createHarness()
    await harness.streams.start({
      requestId: 'request-actions',
      subscriptionId: SUBSCRIPTION_ID,
      payload: subscribePayload(),
      client: harness.client,
      isRequestActive: () => true
    })

    await harness.streams.handle(
      {
        operation: 'displayMode',
        streamId: SUBSCRIPTION_ID,
        mode: 'auto',
        viewport: { cols: 90, rows: 30 }
      },
      harness.client
    )
    await harness.streams.handle(
      { operation: 'rename', streamId: SUBSCRIPTION_ID, title: 'Build' },
      harness.client
    )
    await harness.streams.handle({ operation: 'clear', streamId: SUBSCRIPTION_ID }, harness.client)

    expect(harness.sendRequest).toHaveBeenCalledWith('terminal.setDisplayMode', {
      terminal: 'terminal-secret',
      mode: 'auto',
      client: { id: 'device-secret', type: 'mobile' },
      viewport: { cols: 90, rows: 30 }
    })
    expect(harness.sendRequest).toHaveBeenCalledWith('terminal.rename', {
      terminal: 'terminal-secret',
      title: 'Build'
    })
    expect(harness.sendRequest).toHaveBeenCalledWith('terminal.clearBuffer', {
      terminal: 'terminal-secret'
    })
    expect(JSON.stringify(harness.sendRequest.mock.calls)).not.toContain(PAGE_WORKSPACE_ID)
  })

  it('revokes an active stream when its opaque workspace binding disappears', async () => {
    const harness = createHarness()
    await harness.streams.start({
      requestId: 'request-revoked',
      subscriptionId: SUBSCRIPTION_ID,
      payload: subscribePayload(),
      client: harness.client,
      isRequestActive: () => true
    })
    harness.emitMultiplex({ type: 'ready' })
    const hostStreamId = decodeTerminalStreamJson<Record<string, unknown>>(
      harness.sentFrames.at(-1)!.payload
    )!.streamId as number
    harness.workspaceAuthority.synchronize([])

    expect(() =>
      harness.streams.handle(
        {
          operation: 'resize',
          streamId: SUBSCRIPTION_ID,
          viewport: { cols: 100, rows: 30 }
        },
        harness.client
      )
    ).toThrow('not_found')
    expect(harness.sentFrames.at(-1)).toMatchObject({
      opcode: TerminalStreamOpcode.Unsubscribe,
      streamId: hostStreamId
    })
  })

  it('holds a native-chat input lease without exposing a generic terminal input stream', async () => {
    const harness = createHarness()
    await harness.streams.start({
      requestId: 'request-lease-only',
      subscriptionId: SUBSCRIPTION_ID,
      payload: {
        ...subscribePayload(),
        visible: false,
        leaseOnly: true
      },
      client: harness.client,
      isRequestActive: () => true
    })

    expect(harness.client.subscribe).toHaveBeenCalledWith(
      'terminal.subscribe',
      {
        terminal: 'terminal-secret',
        client: { id: 'device-secret', type: 'mobile' },
        capabilities: { terminalBinaryStream: 1, mobileInputLeaseOnly: 1 }
      },
      expect.any(Function)
    )
    harness.emitLease({ type: 'subscribed' })
    await settle()

    expect(harness.events).toEqual([
      {
        sequence: 0,
        event: {
          type: 'subscribed',
          streamId: SUBSCRIPTION_ID,
          viewport: { cols: 80, rows: 24 },
          startSequence: 0,
          maxOutstandingBytes: 256 * 1024,
          inputFloor: 'held',
          queryReplyAuthority: true
        }
      }
    ])
    expect(() =>
      harness.streams.handle(
        {
          operation: 'input',
          streamId: SUBSCRIPTION_ID,
          sequence: 0,
          data: Buffer.from('must-not-pass').toString('base64')
        },
        harness.client
      )
    ).toThrow('not_found')

    expect(harness.streams.cancel(SUBSCRIPTION_ID, harness.client)).toBe('request-lease-only')
    expect(harness.leaseUnsubscribe).toHaveBeenCalledOnce()
    expect(harness.sentFrames).toEqual([])
  })

  it.each([
    [{ type: 'end' }, { type: 'closed', streamId: SUBSCRIPTION_ID, reason: 'terminal-exited' }],
    [
      { type: 'error' },
      {
        type: 'error',
        streamId: SUBSCRIPTION_ID,
        code: 'unavailable',
        recoverable: true
      }
    ],
    [
      { unexpected: true },
      {
        type: 'error',
        streamId: SUBSCRIPTION_ID,
        code: 'invalid_message',
        recoverable: false
      }
    ]
  ])('delivers a lease terminal event before retiring it', async (hostEvent, expectedEvent) => {
    const harness = createHarness()
    await harness.streams.start({
      requestId: 'request-terminal-event',
      subscriptionId: SUBSCRIPTION_ID,
      payload: {
        ...subscribePayload(),
        visible: false,
        leaseOnly: true
      },
      client: harness.client,
      isRequestActive: () => true
    })

    harness.emitLease(hostEvent)
    await settle()

    expect(harness.events).toEqual([{ sequence: 0, event: expectedEvent }])
    expect(harness.streams.cancel(SUBSCRIPTION_ID, harness.client)).toBeNull()
    expect(harness.leaseUnsubscribe).toHaveBeenCalledOnce()
  })
})

function createHarness() {
  const sentFrames: TerminalStreamFrame[] = []
  const events: { sequence: number; event: MobileWebTerminalEvent }[] = []
  const resyncReasons: string[] = []
  const flowMetrics: { ackLagMs: number | undefined; outstandingBytes: number }[] = []
  let nowMs = 1_000
  let emitMultiplex = (_result: unknown): void => {}
  let emitFrame = (_frame: TerminalStreamFrame): boolean => false
  let emitLease = (_result: unknown): void => {}
  const leaseUnsubscribe = vi.fn()
  const workspaceAuthority = new MobileWebWorkspaceAuthority(() => new Uint8Array(16).fill(9))
  workspaceAuthority.synchronize([{ workspaceId: HOST_WORKSPACE_ID, repoId: '/secret/repo' }])
  const client = {
    sendRequest: vi.fn().mockResolvedValue({
      ok: true,
      result: {
        worktree: HOST_WORKSPACE_ID,
        tabs: [
          {
            id: 'tab-1',
            type: 'terminal',
            status: 'ready',
            terminal: 'terminal-secret'
          }
        ]
      }
    }),
    subscribe: vi.fn((method, _params, listener, options) => {
      if (method === 'terminal.subscribe') {
        emitLease = listener
        return leaseUnsubscribe
      }
      emitMultiplex = listener
      emitFrame = options?.onTerminalBinaryFrame ?? emitFrame
      return vi.fn()
    }),
    sendTerminalBinaryFrame: vi.fn((frame) => {
      sentFrames.push(frame)
      return true
    })
  } as unknown as RpcClient
  const streams = new MobileWebTerminalStreams({
    isActive: () => true,
    clientId: 'device-secret',
    now: () => nowMs,
    onFlowMetrics: (metrics) => flowMetrics.push(metrics),
    onResync: (reason) => resyncReasons.push(reason),
    workspaceAuthority,
    postEvent: async (_subscriptionId, sequence, event) => {
      events.push({ sequence, event })
    }
  })
  return {
    streams,
    workspaceAuthority,
    sendRequest: client.sendRequest,
    client,
    sentFrames,
    flowMetrics,
    advanceTime: (durationMs: number) => {
      nowMs += durationMs
    },
    resyncReasons,
    events,
    emitMultiplex: (result: unknown) => emitMultiplex(result),
    emitFrame: (frame: TerminalStreamFrame) => emitFrame(frame),
    emitLease: (result: unknown) => emitLease(result),
    leaseUnsubscribe
  }
}

function subscribePayload() {
  return {
    operation: 'subscribe',
    workspaceId: PAGE_WORKSPACE_ID,
    tabId: 'tab-1',
    viewport: { cols: 80, rows: 24 },
    visible: true
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
