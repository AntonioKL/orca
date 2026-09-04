import type { MobileWebSubscriptionClosure } from './mobile-web-subscription-closure'
import type { MobileWebSpeechEvent } from '../../../src/shared/mobile-web/speech-operation-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'

type SpeechSubscriber = {
  requestId: string
  sequence: number
  delivery: Promise<void>
  post: (sequence: number, event: MobileWebSpeechEvent) => Promise<void>
  closed: (closure: MobileWebSubscriptionClosure) => void
}

export class MobileWebSpeechSubscriptions {
  private readonly records = new Map<string, SpeechSubscriber>()
  private disposed = false

  start(args: {
    requestId: string
    subscriptionId: string
    post: (sequence: number, event: MobileWebSpeechEvent) => Promise<void>
    closed: (closure: MobileWebSubscriptionClosure) => void
  }): void {
    if (this.disposed || this.records.has(args.subscriptionId)) {
      throw new MobileWebBrokerError('invalid_request')
    }
    this.records.set(args.subscriptionId, {
      requestId: args.requestId,
      sequence: 0,
      delivery: Promise.resolve(),
      post: args.post,
      closed: args.closed
    })
  }

  post(event: MobileWebSpeechEvent): void {
    for (const [subscriptionId, record] of this.records) {
      const sequence = record.sequence++
      record.delivery = record.delivery
        .then(async () => {
          if (this.records.get(subscriptionId) !== record) {
            return
          }
          await record.post(sequence, event)
        })
        .catch(() => {
          if (this.records.get(subscriptionId) === record) {
            this.records.delete(subscriptionId)
            record.closed({ code: 'unavailable', retryable: true })
          }
        })
    }
  }

  cancel(subscriptionId: string): string | null {
    const record = this.records.get(subscriptionId)
    if (!record) {
      return null
    }
    this.records.delete(subscriptionId)
    return record.requestId
  }

  cancelByRequest(requestId: string): void {
    for (const [subscriptionId, record] of this.records) {
      if (record.requestId === requestId) {
        this.records.delete(subscriptionId)
      }
    }
  }

  countForOperation(operationKey: string): number {
    return operationKey === 'speech.subscribe' ? this.records.size : 0
  }

  dispose(): void {
    this.disposed = true
    this.records.clear()
  }
}
