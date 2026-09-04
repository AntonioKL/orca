import type {
  MobileWebPostSubscriptionClosed,
  MobileWebSubscriptionClosure
} from './mobile-web-subscription-closure'
import { MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS } from '../../../src/shared/mobile-web/bridge-contract'
import {
  MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES,
  MobileWebNativeChatEventSchema,
  MobileWebNativeChatSubscribePayloadSchema,
  type MobileWebNativeChatEvent
} from '../../../src/shared/mobile-web/native-chat-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { resolveFreshMobileWebNativeChatBinding } from './mobile-web-native-chat-binding'
import { sanitizeMobileWebNativeChatMessages } from './mobile-web-native-chat-tool-input'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

type SubscriptionRecord = {
  requestId: string
  operationKey: string
  sequence: number
  active: boolean
  hostWorkspaceId: string
  pageSessionId: string
  unsubscribe: () => void
  delivery: Promise<void>
}

export class MobileWebNativeChatSubscriptions {
  private readonly records = new Map<string, SubscriptionRecord>()

  constructor(
    private readonly options: {
      isActive: () => boolean
      postEvent: (
        subscriptionId: string,
        sequence: number,
        event: MobileWebNativeChatEvent
      ) => Promise<void>
      postClosed: MobileWebPostSubscriptionClosed
      nativeChatAuthority: MobileWebNativeChatAuthority
      workspaceAuthority: MobileWebWorkspaceAuthority
    }
  ) {}

  async start(args: {
    requestId: string
    subscriptionId: string
    payload: unknown
    client: RpcClient
    isRequestActive: () => boolean
  }): Promise<void> {
    const payload = MobileWebNativeChatSubscribePayloadSchema.parse(args.payload)
    if (
      this.records.has(args.subscriptionId) ||
      this.records.size >= MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS
    ) {
      throw new MobileWebBrokerError('rate_limited')
    }
    const hostWorkspaceId = this.options.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const binding = await resolveFreshMobileWebNativeChatBinding({
      client: args.client,
      hostWorkspaceId,
      sessionId: payload.sessionId,
      nativeChatAuthority: this.options.nativeChatAuthority
    })
    if (!args.isRequestActive()) {
      throw new MobileWebBrokerError('cancelled')
    }
    const record: SubscriptionRecord = {
      requestId: args.requestId,
      operationKey: 'nativeChat.subscribe',
      sequence: 0,
      active: true,
      hostWorkspaceId,
      pageSessionId: payload.sessionId,
      unsubscribe: () => {},
      delivery: Promise.resolve()
    }
    this.records.set(args.subscriptionId, record)
    try {
      const unsubscribe = args.client.subscribe(
        'nativeChat.subscribe',
        {
          agent: binding.agent,
          sessionId: binding.providerSessionId,
          limit: payload.limit,
          subscriptionId: args.subscriptionId,
          ...(binding.transcriptPath ? { transcriptPath: binding.transcriptPath } : {}),
          ...(binding.hostTerminalId
            ? { worktreeId: binding.hostWorkspaceId, terminal: binding.hostTerminalId }
            : {})
        },
        (event) => this.receive(args.subscriptionId, record, event)
      )
      if (record.active && this.records.get(args.subscriptionId) === record) {
        record.unsubscribe = unsubscribe
      } else {
        unsubscribe()
      }
    } catch {
      this.cancel(args.subscriptionId)
      throw new MobileWebBrokerError('host_error')
    }
  }

  cancel(subscriptionId: string, closure?: MobileWebSubscriptionClosure): string | null {
    const record = this.records.get(subscriptionId)
    if (!record) {
      return null
    }
    record.active = false
    this.records.delete(subscriptionId)
    try {
      record.unsubscribe()
    } catch {
      // The record is already retired.
    }
    if (closure) {
      this.options.postClosed(subscriptionId, closure)
    }
    return record.requestId
  }

  cancelByRequest(requestId: string): void {
    for (const [subscriptionId, record] of this.records) {
      if (record.requestId === requestId) {
        this.cancel(subscriptionId)
      }
    }
  }

  countForOperation(operationKey: string): number {
    let count = 0
    for (const record of this.records.values()) {
      if (record.operationKey === operationKey) {
        count += 1
      }
    }
    return count
  }

  dispose(): void {
    for (const subscriptionId of this.records.keys()) {
      this.cancel(subscriptionId)
    }
  }

  private receive(subscriptionId: string, record: SubscriptionRecord, value: unknown): void {
    if (!record.active || !this.options.isActive() || this.records.get(subscriptionId) !== record) {
      return
    }
    try {
      this.options.nativeChatAuthority.resolve(record.hostWorkspaceId, record.pageSessionId)
    } catch {
      this.cancel(subscriptionId, { code: 'not_found', retryable: false })
      return
    }
    const event = sanitizeEvent(value)
    if (!event) {
      this.cancel(subscriptionId, { code: 'invalid_message', retryable: false })
      return
    }
    if (encodedByteLength(event) > MOBILE_WEB_NATIVE_CHAT_EVENT_MAX_BYTES) {
      this.cancel(subscriptionId, { code: 'too_large', retryable: false })
      return
    }
    const sequence = record.sequence++
    record.delivery = record.delivery
      .then(async () => {
        if (
          record.active &&
          this.options.isActive() &&
          this.records.get(subscriptionId) === record
        ) {
          await this.options.postEvent(subscriptionId, sequence, event)
        }
      })
      .catch(() => {
        this.cancel(subscriptionId, { code: 'unavailable', retryable: true })
      })
  }
}

function sanitizeEvent(value: unknown): MobileWebNativeChatEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null
  }
  const candidate =
    value.type === 'end'
      ? { type: 'end' }
      : value.type === 'error'
        ? { type: 'error', message: value.message }
        : value.type === 'snapshot' || value.type === 'replacement' || value.type === 'appended'
          ? {
              type: value.type,
              messages: sanitizeMobileWebNativeChatMessages(value.messages),
              ...(typeof value.hasMore === 'boolean' ? { hasMore: value.hasMore } : {}),
              ...(safeOffset(value.beforeOffset) === undefined
                ? {}
                : { beforeOffset: value.beforeOffset }),
              ...(typeof value.error === 'string' ? { error: value.error } : {}),
              ...(value.lifecycle === undefined ? {} : { lifecycle: value.lifecycle })
            }
          : null
  const parsed = MobileWebNativeChatEventSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

function safeOffset(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function encodedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
