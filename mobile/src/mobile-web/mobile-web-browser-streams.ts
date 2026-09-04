import type {
  MobileWebPostSubscriptionClosed,
  MobileWebSubscriptionClosure
} from './mobile-web-subscription-closure'
import { Buffer } from 'buffer/'
import { MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS } from '../../../src/shared/mobile-web/bridge-contract'
import {
  MOBILE_WEB_BROWSER_FRAME_CHUNK_BYTES,
  MOBILE_WEB_BROWSER_FRAME_MAX_IMAGE_BYTES,
  MobileWebBrowserEventSchema,
  MobileWebBrowserStreamPayloadSchema,
  type MobileWebBrowserEvent
} from '../../../src/shared/mobile-web/browser-operation-contract'
import type {
  BrowserScreencastFrame,
  BrowserScreencastFrameMetadata
} from '../transport/browser-screencast-protocol'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { sanitizeMobileWebBrowserEvent } from './mobile-web-browser-event-sanitizer'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

type SubscriptionRecord = {
  requestId: string
  operationKey: string
  sequence: number
  active: boolean
  unsubscribe: () => void
  delivery: Promise<void>
  frameQueued: boolean
  pendingFrame: BrowserScreencastFrame | null
}

export class MobileWebBrowserStreams {
  private readonly records = new Map<string, SubscriptionRecord>()

  constructor(
    private readonly options: {
      isActive: () => boolean
      workspaceAuthority: MobileWebWorkspaceAuthority
      browserAuthority: MobileWebBrowserAuthority
      postEvent: (
        subscriptionId: string,
        sequence: number,
        event: MobileWebBrowserEvent
      ) => Promise<void>
      postClosed: MobileWebPostSubscriptionClosed
    }
  ) {}

  start(args: {
    requestId: string
    subscriptionId: string
    payload: unknown
    client: RpcClient
  }): void {
    if (this.records.has(args.subscriptionId)) {
      throw new MobileWebBrowserStreamError('invalid_request')
    }
    if (this.records.size >= MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS) {
      throw new MobileWebBrowserStreamError('rate_limited')
    }
    const payload = MobileWebBrowserStreamPayloadSchema.parse(args.payload)
    const hostWorkspaceId = this.options.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const hostPageId = this.options.browserAuthority.hostPageId(hostWorkspaceId, payload.pageId)
    const record: SubscriptionRecord = {
      requestId: args.requestId,
      operationKey: 'browser.subscribe',
      sequence: 0,
      active: true,
      unsubscribe: () => {},
      delivery: Promise.resolve(),
      frameQueued: false,
      pendingFrame: null
    }
    this.records.set(args.subscriptionId, record)
    try {
      const unsubscribe = args.client.subscribe(
        'browser.screencast',
        {
          worktree: `id:${hostWorkspaceId}`,
          page: hostPageId,
          format: payload.format,
          quality: payload.quality,
          maxWidth: payload.maxWidth,
          maxHeight: payload.maxHeight,
          everyNthFrame: payload.everyNthFrame,
          minFrameIntervalMs: payload.minFrameIntervalMs,
          ...(payload.viewportWidth === undefined ? {} : { viewportWidth: payload.viewportWidth }),
          ...(payload.viewportHeight === undefined
            ? {}
            : { viewportHeight: payload.viewportHeight }),
          ...(payload.deviceScaleFactor === undefined
            ? {}
            : { deviceScaleFactor: payload.deviceScaleFactor }),
          ...(payload.mobile === undefined ? {} : { mobile: payload.mobile })
        },
        (event) => this.receiveEvent(args.subscriptionId, record, event),
        {
          onBinaryFrame: (frame) => this.receiveFrame(args.subscriptionId, record, frame)
        }
      )
      if (record.active && this.records.get(args.subscriptionId) === record) {
        record.unsubscribe = unsubscribe
      } else {
        unsubscribe()
      }
    } catch {
      this.cancel(args.subscriptionId)
      throw new MobileWebBrowserStreamError('host_error')
    }
  }

  cancel(subscriptionId: string, closure?: MobileWebSubscriptionClosure): string | null {
    const record = this.records.get(subscriptionId)
    if (!record) {
      return null
    }
    record.active = false
    record.pendingFrame = null
    this.records.delete(subscriptionId)
    try {
      record.unsubscribe()
    } catch {
      // The local record is already retired.
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

  private receiveEvent(subscriptionId: string, record: SubscriptionRecord, value: unknown): void {
    if (!this.isCurrent(subscriptionId, record)) {
      return
    }
    const event = sanitizeMobileWebBrowserEvent(value)
    if (event) {
      this.enqueue(subscriptionId, record, () => this.deliver(subscriptionId, record, event))
    }
  }

  private receiveFrame(
    subscriptionId: string,
    record: SubscriptionRecord,
    frame: BrowserScreencastFrame
  ): void {
    if (!this.isCurrent(subscriptionId, record)) {
      return
    }
    if (frame.image.byteLength > MOBILE_WEB_BROWSER_FRAME_MAX_IMAGE_BYTES) {
      this.enqueue(subscriptionId, record, () =>
        this.deliver(subscriptionId, record, {
          type: 'error',
          message: 'Browser frame is too large to display safely.'
        })
      )
      return
    }
    record.pendingFrame = frame
    if (record.frameQueued) {
      return
    }
    record.frameQueued = true
    this.enqueue(subscriptionId, record, async () => {
      const latest = record.pendingFrame
      record.pendingFrame = null
      if (latest) {
        await this.deliverFrame(subscriptionId, record, latest)
      }
      record.frameQueued = false
      const pending = record.pendingFrame
      if (pending && this.isCurrent(subscriptionId, record)) {
        record.pendingFrame = null
        this.receiveFrame(subscriptionId, record, pending)
      }
    })
  }

  private enqueue(
    subscriptionId: string,
    record: SubscriptionRecord,
    task: () => Promise<void>
  ): void {
    record.delivery = record.delivery
      .then(async () => {
        if (this.isCurrent(subscriptionId, record)) {
          await task()
        }
      })
      .catch(() => {
        this.cancel(subscriptionId, { code: 'unavailable', retryable: true })
      })
  }

  private async deliverFrame(
    subscriptionId: string,
    record: SubscriptionRecord,
    frame: BrowserScreencastFrame
  ): Promise<void> {
    const chunkCount = Math.ceil(frame.image.byteLength / MOBILE_WEB_BROWSER_FRAME_CHUNK_BYTES)
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      if (!this.isCurrent(subscriptionId, record)) {
        return
      }
      const start = chunkIndex * MOBILE_WEB_BROWSER_FRAME_CHUNK_BYTES
      const end = Math.min(frame.image.byteLength, start + MOBILE_WEB_BROWSER_FRAME_CHUNK_BYTES)
      await this.deliver(subscriptionId, record, {
        type: 'frameChunk',
        frameSequence: frame.seq,
        format: frame.format,
        metadata: boundedMetadata(frame.metadata),
        imageBytes: frame.image.byteLength,
        chunkIndex,
        chunkCount,
        data: Buffer.from(frame.image.subarray(start, end)).toString('base64')
      })
    }
  }

  private async deliver(
    subscriptionId: string,
    record: SubscriptionRecord,
    value: MobileWebBrowserEvent
  ): Promise<void> {
    const event = MobileWebBrowserEventSchema.parse(value)
    const sequence = record.sequence
    record.sequence += 1
    await this.options.postEvent(subscriptionId, sequence, event)
  }

  private isCurrent(subscriptionId: string, record: SubscriptionRecord): boolean {
    return record.active && this.options.isActive() && this.records.get(subscriptionId) === record
  }
}

export class MobileWebBrowserStreamError extends Error {
  constructor(readonly code: 'invalid_request' | 'rate_limited' | 'host_error') {
    super(code)
  }
}

function boundedMetadata(metadata: BrowserScreencastFrameMetadata): BrowserScreencastFrameMetadata {
  const parsed = MobileWebBrowserEventSchema.parse({
    type: 'frameChunk',
    frameSequence: 0,
    format: 'jpeg',
    metadata,
    imageBytes: 1,
    chunkIndex: 0,
    chunkCount: 1,
    data: 'AA=='
  })
  if (parsed.type !== 'frameChunk') {
    throw new MobileWebBrowserStreamError('host_error')
  }
  return parsed.metadata
}
