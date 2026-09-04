import type { MobileWebHostWorkspaceId } from './mobile-web-workspace-authority'
import {
  MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS,
  type MobileWebBridgeErrorCode
} from '../../../src/shared/mobile-web/bridge-contract'
import {
  MOBILE_WEB_SESSION_EVENT_MAX_BYTES,
  type MobileWebSessionSnapshotResult
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import type { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { mobileWebSessionSnapshot } from './mobile-web-session-snapshot'

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
      postError: (
        requestId: string,
        code: MobileWebBridgeErrorCode,
        retryable: boolean
      ) => Promise<void>
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
      throw new MobileWebSessionSubscriptionError('invalid_request')
    }
    if (this.records.size >= MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS) {
      throw new MobileWebSessionSubscriptionError('rate_limited')
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
      throw new MobileWebSessionSubscriptionError('host_error')
    }
  }

  cancel(subscriptionId: string): string | null {
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
      this.fail(subscriptionId, 'host_error', true)
      return
    }
    if (encodedByteLength(snapshot) > MOBILE_WEB_SESSION_EVENT_MAX_BYTES) {
      this.fail(subscriptionId, 'too_large', false)
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
        this.fail(subscriptionId, 'unavailable', true)
      })
  }

  // Why: the page waits on this stream to leave its loading state, so a shell-side
  // drop it never hears about strands the session screen on the spinner forever.
  private fail(subscriptionId: string, code: MobileWebBridgeErrorCode, retryable: boolean): void {
    const requestId = this.cancel(subscriptionId)
    if (requestId) {
      void this.options.postError(requestId, code, retryable)
    }
  }
}

export class MobileWebSessionSubscriptionError extends Error {
  constructor(readonly code: 'invalid_request' | 'rate_limited' | 'host_error') {
    super(code)
  }
}

function encodedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
