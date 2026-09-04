import type {
  MobileWebPostSubscriptionClosed,
  MobileWebSubscriptionClosure
} from './mobile-web-subscription-closure'
import { MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS } from '../../../src/shared/mobile-web/bridge-contract'
import type { MobileWebAccountEvent } from '../../../src/shared/mobile-web/account-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { mobileWebAccountEvent } from './mobile-web-account-presentation'
import { MobileWebBrokerError } from './mobile-web-broker-error'

type SubscriptionRecord = {
  requestId: string
  sequence: number
  active: boolean
  unsubscribe: () => void
  delivery: Promise<void>
}

export class MobileWebAccountSubscriptions {
  private readonly records = new Map<string, SubscriptionRecord>()

  constructor(
    private readonly options: {
      isActive: () => boolean
      postEvent: (
        subscriptionId: string,
        sequence: number,
        event: MobileWebAccountEvent
      ) => Promise<void>
      postClosed: MobileWebPostSubscriptionClosed
    }
  ) {}

  start(args: { requestId: string; subscriptionId: string; client: RpcClient }): void {
    if (this.records.has(args.subscriptionId)) {
      throw new MobileWebBrokerError('invalid_request')
    }
    if (this.records.size >= MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS) {
      throw new MobileWebBrokerError('rate_limited')
    }
    const record: SubscriptionRecord = {
      requestId: args.requestId,
      sequence: 0,
      active: true,
      unsubscribe: () => {},
      delivery: Promise.resolve()
    }
    this.records.set(args.subscriptionId, record)
    try {
      const unsubscribe = args.client.subscribe('accounts.subscribe', null, (event) =>
        this.receive(args.subscriptionId, record, event)
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
      // The page authority is retired even when host subscription cleanup fails.
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
    return operationKey === 'account.subscribe' ? this.records.size : 0
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
    const event = mobileWebAccountEvent(value)
    if (!event) {
      this.cancel(subscriptionId, { code: 'invalid_message', retryable: false })
      return
    }
    const retireAfterDelivery = event.type === 'end' || event.type === 'error'
    const sequence = record.sequence
    record.sequence += 1
    record.delivery = record.delivery
      .then(async () => {
        if (
          record.active &&
          this.options.isActive() &&
          this.records.get(subscriptionId) === record
        ) {
          await this.options.postEvent(subscriptionId, sequence, event)
          if (retireAfterDelivery) {
            this.cancel(subscriptionId)
          }
        }
      })
      .catch(() => {
        this.cancel(subscriptionId, { code: 'unavailable', retryable: true })
      })
  }
}
