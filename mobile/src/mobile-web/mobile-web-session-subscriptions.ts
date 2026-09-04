import type {
  MobileWebPostSubscriptionClosed,
  MobileWebSubscriptionClosure
} from './mobile-web-subscription-closure'
import type { MobileWebHostWorkspaceId } from './mobile-web-workspace-authority'
import { MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS } from '../../../src/shared/mobile-web/bridge-contract'
import {
  MOBILE_WEB_SESSION_EVENT_MAX_BYTES,
  type MobileWebSessionSnapshotResult
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import type { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { mobileWebSessionSnapshot } from './mobile-web-session-snapshot'
import { MobileWebBrokerError } from './mobile-web-broker-error'

type SubscriptionRecord = {
  requestId: string
  operationKey: string
  sequence: number
  active: boolean
  unsubscribe: () => void
  delivery: Promise<void>
}

export class MobileWebSessionSubscriptions {
  private readonly records = new Map<string, SubscriptionRecord>()

  constructor(
    private readonly options: {
      isActive: () => boolean
      postEvent: (
        subscriptionId: string,
        sequence: number,
        snapshot: MobileWebSessionSnapshotResult
      ) => Promise<void>
      postClosed: MobileWebPostSubscriptionClosed
      browserAuthority: MobileWebBrowserAuthority
      nativeChatAuthority: MobileWebNativeChatAuthority
    }
  ) {}

  start(args: {
    requestId: string
    subscriptionId: string
    pageWorkspaceId: string
    hostWorkspaceId: MobileWebHostWorkspaceId
    client: RpcClient
  }): void {
    if (this.records.has(args.subscriptionId)) {
      throw new MobileWebBrokerError('invalid_request')
    }
    if (this.records.size >= MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS) {
      throw new MobileWebBrokerError('rate_limited')
    }
    const record: SubscriptionRecord = {
      requestId: args.requestId,
      operationKey: 'session.subscribe',
      sequence: 0,
      active: true,
      unsubscribe: () => {},
      delivery: Promise.resolve()
    }
    this.records.set(args.subscriptionId, record)
    try {
      const unsubscribe = args.client.subscribe(
        'session.tabs.subscribe',
        { worktree: `id:${args.hostWorkspaceId}` },
        (event) =>
          this.receive(
            args.subscriptionId,
            record,
            args.hostWorkspaceId,
            args.pageWorkspaceId,
            event
          )
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
      // The local record is already retired; a broken transport teardown must not revive it.
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

  private receive(
    subscriptionId: string,
    record: SubscriptionRecord,
    hostWorkspaceId: MobileWebHostWorkspaceId,
    pageWorkspaceId: string,
    event: unknown
  ): void {
    if (!record.active || !this.options.isActive() || this.records.get(subscriptionId) !== record) {
      return
    }
    let snapshot: MobileWebSessionSnapshotResult
    try {
      snapshot = mobileWebSessionSnapshot(
        event,
        hostWorkspaceId,
        pageWorkspaceId,
        this.options.browserAuthority,
        this.options.nativeChatAuthority
      )
    } catch {
      this.cancel(subscriptionId, { code: 'invalid_message', retryable: false })
      return
    }
    // Why still here: the projection already trims tabs to fit, so this only fires on an envelope
    // no bounded tab list can rescue — and now it says so instead of going quiet.
    if (encodedByteLength(snapshot) > MOBILE_WEB_SESSION_EVENT_MAX_BYTES) {
      this.cancel(subscriptionId, { code: 'too_large', retryable: false })
      return
    }
    const sequence = record.sequence
    record.sequence += 1
    record.delivery = record.delivery
      .then(async () => {
        if (
          record.active &&
          this.options.isActive() &&
          this.records.get(subscriptionId) === record
        ) {
          await this.options.postEvent(subscriptionId, sequence, snapshot)
        }
      })
      .catch(() => {
        this.cancel(subscriptionId, { code: 'unavailable', retryable: true })
      })
  }
}

function encodedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
