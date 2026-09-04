import { MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS } from '../../../src/shared/mobile-web/bridge-contract'
import type { MobileWebSourceControlStatusInvalidation } from '../../../src/shared/mobile-web/source-control-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { MobileWebBrokerError } from './mobile-web-broker-error'

type SubscriptionRecord = {
  requestId: string
  operationKey: string
  pageWorkspaceId: string
  hostWorkspaceId: string
  sequence: number
  active: boolean
  closing: boolean
  unsubscribe: () => void
  delivery: Promise<void>
}

const MAX_FILE_WATCH_EVENTS = 5_000

export class MobileWebSourceControlSubscriptions {
  private readonly records = new Map<string, SubscriptionRecord>()

  constructor(
    private readonly options: {
      isActive: () => boolean
      workspaceAuthority: MobileWebWorkspaceAuthority
      postEvent: (
        subscriptionId: string,
        sequence: number,
        event: MobileWebSourceControlStatusInvalidation
      ) => Promise<void>
    }
  ) {}

  start(args: {
    requestId: string
    subscriptionId: string
    pageWorkspaceId: string
    hostWorkspaceId: string
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
      operationKey: 'sourceControl.subscribe',
      pageWorkspaceId: args.pageWorkspaceId,
      hostWorkspaceId: args.hostWorkspaceId,
      sequence: 0,
      active: true,
      closing: false,
      unsubscribe: () => {},
      delivery: Promise.resolve()
    }
    this.records.set(args.subscriptionId, record)
    try {
      const unsubscribe = args.client.subscribe(
        'files.watch',
        { worktree: `id:${args.hostWorkspaceId}` },
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
      // The logical subscription is retired even if transport cleanup fails.
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
    if (!this.isAuthorized(record)) {
      this.cancel(subscriptionId)
      return
    }
    if (
      !record.active ||
      record.closing ||
      !this.options.isActive() ||
      this.records.get(subscriptionId) !== record
    ) {
      return
    }
    if (!isRecord(value)) {
      this.cancel(subscriptionId)
      return
    }
    if (value.type === 'starting' || value.type === 'ready') {
      return
    }
    if (value.type === 'changed') {
      if (value.worktree !== `id:${record.hostWorkspaceId}` || !Array.isArray(value.events)) {
        this.cancel(subscriptionId)
        return
      }
      const overflow =
        value.events.length > MAX_FILE_WATCH_EVENTS ||
        value.events.some((event) => isRecord(event) && event.kind === 'overflow')
      this.enqueue(subscriptionId, record, {
        workspaceId: record.pageWorkspaceId,
        reason: overflow ? 'overflow' : 'changed'
      })
      return
    }
    if (value.type === 'error' || value.type === 'end') {
      record.closing = true
      this.enqueue(
        subscriptionId,
        record,
        { workspaceId: record.pageWorkspaceId, reason: 'unavailable' },
        true
      )
      return
    }
    this.cancel(subscriptionId)
  }

  private enqueue(
    subscriptionId: string,
    record: SubscriptionRecord,
    event: MobileWebSourceControlStatusInvalidation,
    retireAfterDelivery = false
  ): void {
    const sequence = record.sequence
    record.sequence += 1
    record.delivery = record.delivery
      .then(async () => {
        if (
          !record.active ||
          !this.options.isActive() ||
          this.records.get(subscriptionId) !== record
        ) {
          return
        }
        if (!this.isAuthorized(record)) {
          this.cancel(subscriptionId)
          return
        }
        await this.options.postEvent(subscriptionId, sequence, event)
        if (retireAfterDelivery) {
          this.cancel(subscriptionId)
        }
      })
      .catch(() => {
        this.cancel(subscriptionId)
      })
  }

  private isAuthorized(record: SubscriptionRecord): boolean {
    try {
      return (
        this.options.workspaceAuthority.hostWorkspaceId(record.pageWorkspaceId) ===
        record.hostWorkspaceId
      )
    } catch {
      return false
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
