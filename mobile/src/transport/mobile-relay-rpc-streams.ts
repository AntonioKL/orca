import { decodeBrowserScreencastFrame } from './browser-screencast-protocol'
import {
  handleTerminalBinaryFrame,
  type TerminalSnapshotState
} from './rpc-client-terminal-binary-frame'
import {
  buildStreamUnsubscribe,
  buildTerminalUnsubscribeParams,
  updateTerminalSubscriptionViewport
} from './rpc-client-terminal-subscription'
import type { RpcClient } from './rpc-client'
import { buildServerSubscriptionUnsubscribe } from './rpc-client-server-subscription'
import { decodeTerminalStreamFrame } from './terminal-stream-protocol'
import type { RpcResponse, RpcSuccess } from './types'

type StreamRecord = {
  method: string
  params: unknown
  listener: (result: unknown) => void
  onBinaryFrame?: Parameters<RpcClient['subscribe']>[3] extends
    | { onBinaryFrame?: infer Listener }
    | undefined
    ? Listener
    : never
  onTerminalBinaryFrame?: NonNullable<
    Parameters<RpcClient['subscribe']>[3]
  >['onTerminalBinaryFrame']
  streamIds: Set<number>
  subscriptionId?: string
  cancelled: boolean
  sent?: boolean
}

type StreamManagerOptions = {
  nextId: () => string
  sendFrame: (request: { id: string; method: string; params?: unknown }) => boolean
  waitForConnected: () => Promise<void>
}

export class MobileRelayRpcStreams {
  private readonly streams = new Map<string, StreamRecord>()
  private readonly terminalListeners = new Map<number, (result: unknown) => void>()
  private readonly terminalSnapshots = new Map<number, TerminalSnapshotState>()
  private activeBrowserStream: StreamRecord | null = null
  private activeTerminalMultiplexStream: StreamRecord | null = null

  constructor(private readonly options: StreamManagerOptions) {}

  subscribe(
    method: string,
    params: unknown,
    listener: (result: unknown) => void,
    subscribeOptions?: Parameters<RpcClient['subscribe']>[3]
  ): () => void {
    const id = this.options.nextId()
    const stream: StreamRecord = {
      method,
      params,
      listener,
      onBinaryFrame: subscribeOptions?.onBinaryFrame,
      onTerminalBinaryFrame: subscribeOptions?.onTerminalBinaryFrame,
      streamIds: new Set(),
      cancelled: false
    }
    this.streams.set(id, stream)
    void this.options
      .waitForConnected()
      .then(() => {
        if (!stream.cancelled) {
          stream.sent = this.options.sendFrame({ id, method, params: stream.params })
          if (!stream.sent) {
            this.fail(id, stream, 'Connection interrupted')
          }
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Connection interrupted'
        this.fail(id, stream, message, error)
      })
    return () => this.cancel(id)
  }

  updateTerminalViewport(terminal: string, viewport: { cols: number; rows: number }): void {
    updateTerminalSubscriptionViewport(this.streams.values(), terminal, viewport)
  }

  handleResponse(response: RpcResponse): boolean {
    const stream = this.streams.get(response.id)
    if (!stream) {
      return false
    }
    if (!response.ok) {
      if (stream.cancelled) {
        this.remove(response.id)
        return true
      }
      this.fail(response.id, stream, response.error.message, response.error)
      return true
    }
    const result = (response as RpcSuccess).result
    if (result && typeof result === 'object') {
      const metadata = result as { subscriptionId?: unknown; streamId?: unknown; type?: unknown }
      if (typeof metadata.subscriptionId === 'string') {
        stream.subscriptionId = metadata.subscriptionId
      }
      if (stream.cancelled) {
        if (stream.subscriptionId || metadata.type === 'end') {
          this.sendServerUnsubscribe(stream)
          this.remove(response.id)
        }
        return true
      }
      if (typeof metadata.streamId === 'number') {
        stream.streamIds.add(metadata.streamId)
        this.terminalListeners.set(metadata.streamId, stream.listener)
      }
      if (stream.method === 'browser.screencast') {
        this.activeBrowserStream = stream
      }
      if (stream.method === 'terminal.multiplex') {
        this.activeTerminalMultiplexStream = stream
      }
      if (metadata.type === 'end') {
        stream.listener(result)
        this.remove(response.id)
        return true
      }
    }
    if (!stream.cancelled) {
      stream.listener(result)
    }
    return true
  }

  handleBinary(bytes: Uint8Array): void {
    const browserFrame = decodeBrowserScreencastFrame(bytes)
    if (browserFrame && this.activeBrowserStream?.onBinaryFrame) {
      this.activeBrowserStream.onBinaryFrame(browserFrame)
      return
    }
    const terminalFrame = decodeTerminalStreamFrame(bytes)
    if (
      terminalFrame &&
      this.activeTerminalMultiplexStream?.onTerminalBinaryFrame?.(terminalFrame) === true
    ) {
      return
    }
    handleTerminalBinaryFrame(bytes, {
      terminalSnapshots: this.terminalSnapshots,
      getListener: (streamId) => this.terminalListeners.get(streamId)
    })
  }

  clear(): void {
    for (const stream of this.streams.values()) {
      stream.cancelled = true
    }
    this.streams.clear()
    this.terminalListeners.clear()
    this.terminalSnapshots.clear()
    this.activeBrowserStream = null
    this.activeTerminalMultiplexStream = null
  }

  private cancel(id: string): void {
    const stream = this.streams.get(id)
    if (!stream || stream.cancelled) {
      return
    }
    stream.cancelled = true
    if (!stream.sent) {
      this.remove(id)
      return
    }
    if (stream.method === 'terminal.subscribe') {
      const params = buildTerminalUnsubscribeParams(stream.params)
      if (params) {
        this.options.sendFrame({
          id: this.options.nextId(),
          method: 'terminal.unsubscribe',
          params
        })
      }
    } else if (buildServerSubscriptionUnsubscribe(stream.method, 'pending')) {
      if (!stream.subscriptionId) {
        return
      }
      this.sendServerUnsubscribe(stream)
    } else {
      const unsubscribe =
        buildStreamUnsubscribe(stream.method, stream.params) ??
        (stream.subscriptionId
          ? {
              method: stream.method.replace(/\.subscribe$/, '.unsubscribe'),
              params: { subscriptionId: stream.subscriptionId }
            }
          : null)
      if (unsubscribe) {
        this.options.sendFrame({ id: this.options.nextId(), ...unsubscribe })
      }
    }
    this.remove(id)
  }

  private sendServerUnsubscribe(stream: StreamRecord): void {
    if (!stream.subscriptionId) {
      return
    }
    const unsubscribe = buildServerSubscriptionUnsubscribe(stream.method, stream.subscriptionId)
    if (unsubscribe) {
      this.options.sendFrame({ id: this.options.nextId(), ...unsubscribe })
    }
  }

  private remove(id: string): void {
    const stream = this.streams.get(id)
    if (!stream) {
      return
    }
    for (const streamId of stream.streamIds) {
      this.terminalListeners.delete(streamId)
      this.terminalSnapshots.delete(streamId)
    }
    if (this.activeBrowserStream === stream) {
      this.activeBrowserStream = null
    }
    if (this.activeTerminalMultiplexStream === stream) {
      this.activeTerminalMultiplexStream = null
    }
    this.streams.delete(id)
  }

  private fail(id: string, stream: StreamRecord, message: string, error?: unknown): void {
    if (stream.cancelled || this.streams.get(id) !== stream) {
      return
    }
    try {
      stream.listener({ type: 'error', message, error })
    } finally {
      this.remove(id)
    }
  }
}
