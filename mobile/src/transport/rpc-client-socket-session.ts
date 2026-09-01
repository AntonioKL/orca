import { decrypt, deriveSharedKey, generateKeyPair, publicKeyToBase64 } from './e2ee'
import { createMobileDirectRpcOutbound } from './mobile-direct-rpc-outbound'
import { createMobileDirectRpcSender } from './mobile-direct-rpc-sender'
import {
  createMobileInboundFrameQueue,
  MOBILE_INBOUND_BUFFER_OVERFLOW_MESSAGE,
  MOBILE_INBOUND_FRAME_TOO_LARGE_MESSAGE,
  mobileInboundFrameLogDetail,
  type MobileInboundFrameQueue
} from './mobile-inbound-frame-queue'
import { tryParseMobileJsonTextWithinLimits } from './mobile-json-text-admission'
import { handleMobileRpcSocketBinaryMessage } from './mobile-rpc-binary-frame-handler'
import { sendMobileTerminalBinaryFrame } from './mobile-terminal-binary-sender'
import { redactedWebSocketEndpoint } from './redacted-websocket-endpoint'
import { isRpcResponse } from './rpc-response-shape'
import { RpcClientSocketTimeouts } from './rpc-client-socket-timeouts'
import { isStaleRpcSocketEvent, logRpcSocketClose } from './rpc-socket-close-evidence'
import { describeSocketEvent } from './socket-event-debug'
import type { TerminalStreamFrame } from './terminal-stream-protocol'
import type { ConnectionLogEmitter, ConnectionState, RpcResponse } from './types'

type SocketSessionOptions = {
  endpoint: string
  deviceToken: string
  serverPublicKey: Uint8Array
  getCurrentSocket: () => WebSocket | null
  getState: () => ConnectionState
  getReconnectAttempt: () => number
  isIntentionallyClosed: () => boolean
  emitLog: ConnectionLogEmitter
  onHandshakeStarted: () => void
  onAuthenticated: (session: RpcClientSocketSession) => void
  onAuthRejected: (reason: string) => void
  onRpcResponse: (response: RpcResponse) => void
  onBinary: (bytes: Uint8Array) => void
  onAnyInbound: (receivedAt: number) => void
  onAuthenticatedInbound: (session: RpcClientSocketSession) => void
  onClosed: (session: RpcClientSocketSession, closeCode?: number) => void
  onForcedClose: (session: RpcClientSocketSession) => void
}

export class RpcClientSocketSession {
  readonly socket: WebSocket
  readonly constructedAt = Date.now()
  private sharedKey: Uint8Array | null = null
  private authenticated = false
  private lastInboundAt: number | null = null
  private readonly timeouts: RpcClientSocketTimeouts
  private readonly outbound: ReturnType<typeof createMobileDirectRpcOutbound>
  private readonly inboundQueue: MobileInboundFrameQueue
  readonly sendEncrypted: (request: unknown) => boolean

  constructor(private readonly options: SocketSessionOptions) {
    this.socket = new WebSocket(options.endpoint)
    this.outbound = createMobileDirectRpcOutbound({
      socket: this.socket,
      isActive: () => this.options.getCurrentSocket() === this.socket,
      onOverflow: () => this.closeForOverload('Outbound', 'Mobile RPC outbound buffer overflow')
    })
    this.inboundQueue = createMobileInboundFrameQueue({
      process: (raw) => this.handleMessage(raw),
      onError: (error) => this.closeForOverload('Inbound', mobileInboundFrameLogDetail(error)),
      overflowMessage: MOBILE_INBOUND_BUFFER_OVERFLOW_MESSAGE,
      frameTooLargeMessage: MOBILE_INBOUND_FRAME_TOO_LARGE_MESSAGE
    })
    this.sendEncrypted = createMobileDirectRpcSender({
      getOutbound: () => this.outbound,
      getSharedKey: () => this.sharedKey,
      getSocket: () => this.socket,
      getState: () => this.options.getState(),
      onSocketDesync: () => this.options.onForcedClose(this)
    })
    this.timeouts = new RpcClientSocketTimeouts({
      emitLog: options.emitLog,
      getReconnectAttempt: options.getReconnectAttempt,
      expire: () => this.options.onForcedClose(this)
    })
    this.attachHandlers()
    this.timeouts.armConnect(
      () => this.options.getCurrentSocket() === this.socket,
      () => this.socket.readyState
    )
  }

  sendTerminalBinaryFrame(frame: TerminalStreamFrame): boolean {
    return sendMobileTerminalBinaryFrame({
      frame,
      socket: this.socket,
      sharedKey: this.sharedKey,
      isConnected: this.options.getState() === 'connected',
      onSocketClosed: () => this.options.onForcedClose(this)
    })
  }

  close(): void {
    this.socket.close()
  }

  dispose(): void {
    this.inboundQueue.dispose()
    this.outbound.dispose()
  }

  private closeForOverload(direction: 'Inbound' | 'Outbound', detail: string): void {
    this.options.emitLog('error', `${direction} WebSocket overload`, detail)
    this.options.onForcedClose(this)
  }

  clearTimers(): void {
    this.timeouts.clearAll()
  }

  clearKey(): void {
    this.sharedKey = null
  }

  private attachHandlers(): void {
    this.socket.onopen = () => {
      if (this.isStale('open')) {
        return
      }
      console.log('[net] ws.onopen', { attempt: this.options.getReconnectAttempt() })
      this.timeouts.clearConnect()
      this.options.onHandshakeStarted()
      this.options.emitLog('success', 'WebSocket open', 'Starting E2EE handshake')
      const ephemeral = generateKeyPair()
      const hello = JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: publicKeyToBase64(ephemeral.publicKey)
      })
      try {
        this.socket.send(hello)
      } catch {
        this.options.onForcedClose(this)
        return
      }
      this.options.emitLog('info', 'Sent e2ee_hello', 'Awaiting server e2ee_ready')
      this.sharedKey = deriveSharedKey(ephemeral.secretKey, this.options.serverPublicKey)
      this.timeouts.armHandshake(
        () => this.options.getCurrentSocket() === this.socket && !this.authenticated
      )
    }
    this.socket.onmessage = (event) => {
      if (!this.isStale('message')) {
        void this.inboundQueue.enqueue(event.data)
      }
    }
    this.socket.onclose = (event) => {
      this.inboundQueue.dispose()
      this.outbound.socketClosed()
      const closeCode = logRpcSocketClose({
        event,
        state: this.options.getState(),
        attempt: this.options.getReconnectAttempt(),
        intentionallyClosed: this.options.isIntentionallyClosed(),
        endpoint: redactedWebSocketEndpoint(this.options.endpoint),
        constructedAt: this.constructedAt,
        authenticated: this.authenticated,
        lastInboundAt: this.lastInboundAt
      })
      this.options.onClosed(this, closeCode)
    }
    this.socket.onerror = (event) => {
      if (this.isStale('error')) {
        return
      }
      console.log('[net] ws.onerror', {
        state: this.options.getState(),
        attempt: this.options.getReconnectAttempt(),
        eventFields: describeSocketEvent(event).fields
      })
    }
  }

  private handleMessage(rawData: unknown): Promise<void> | void {
    const receivedAt = Date.now()
    this.lastInboundAt = receivedAt
    this.options.onAnyInbound(receivedAt)
    const raw = typeof rawData === 'string' ? rawData : null
    if (!this.authenticated) {
      this.handleHandshakeMessage(raw)
      return
    }
    const key = this.sharedKey
    if (!key || key.length !== 32) {
      return
    }
    if (raw === null) {
      return handleMobileRpcSocketBinaryMessage({
        rawData,
        key,
        isCurrent: () => this.options.getCurrentSocket() === this.socket,
        onFrame: (plaintext) => {
          this.options.onAuthenticatedInbound(this)
          this.options.onBinary(plaintext)
        }
      })
    }
    const plaintext = decrypt(raw, key)
    if (plaintext === null) {
      return
    }
    this.options.onAuthenticatedInbound(this)
    const response = tryParseMobileJsonTextWithinLimits(plaintext)
    if (!isRpcResponse(response)) {
      return
    }
    this.outbound.acknowledge(response.id)
    this.options.onRpcResponse(response)
  }

  private handleHandshakeMessage(raw: string | null): void {
    if (raw === null) {
      return
    }
    const plaintextControl = tryParseMobileJsonTextWithinLimits<{ type?: unknown }>(raw)
    if (plaintextControl?.type === 'e2ee_ready') {
      this.options.emitLog('success', 'Received e2ee_ready', 'Sending device token')
      this.sendEncrypted({ type: 'e2ee_auth', deviceToken: this.options.deviceToken })
      return
    }
    if (!this.sharedKey || this.sharedKey.length !== 32) {
      return
    }
    const plaintext = decrypt(raw, this.sharedKey)
    if (plaintext === null) {
      return
    }
    const message = tryParseMobileJsonTextWithinLimits<{
      type?: unknown
      ok?: unknown
      error?: { code?: unknown }
    }>(plaintext)
    if (!message) {
      return
    }
    if (message.type === 'e2ee_authenticated') {
      this.outbound.acknowledgeAuthentication()
      this.timeouts.clearHandshake()
      this.authenticated = true
      this.options.onAuthenticated(this)
    } else if (
      message.type === 'e2ee_error' ||
      (message.ok === false && message.error?.code === 'unauthorized')
    ) {
      this.outbound.acknowledgeAuthentication()
      // Why: the failure signal is loggable; the server error body is not.
      console.log('[net] e2ee auth FAILED', {
        signal: message.type === 'e2ee_error' ? 'e2ee_error' : 'unauthorized_response'
      })
      this.timeouts.clearHandshake()
      this.options.onAuthRejected('Unauthorized — pairing may be revoked')
    }
  }

  private isStale(eventName: string): boolean {
    return isStaleRpcSocketEvent(
      this.options.getCurrentSocket(),
      this.socket,
      eventName,
      this.options.getState(),
      this.options.getReconnectAttempt()
    )
  }
}
