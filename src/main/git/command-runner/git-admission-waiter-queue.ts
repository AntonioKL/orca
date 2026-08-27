import type { AdmissionClass, AdmissionSlotKind, AdmissionWaiter } from './git-admission-state'
import type { GitAdmissionTier } from './git-exec-options'

type SelectedWaiter = {
  waiter: AdmissionWaiter
  slotKind: AdmissionSlotKind
}

type WaiterLane = {
  items: AdmissionWaiter[]
  head: number
  count: number
}

const TIERS = ['interactive', 'status', 'background'] as const
const createLane = (): WaiterLane => ({ items: [], head: 0, count: 0 })

export class GitAdmissionWaiterQueue {
  private readonly lanes: Record<AdmissionClass, Record<GitAdmissionTier, WaiterLane>> = {
    general: {
      interactive: createLane(),
      status: createLane(),
      background: createLane()
    },
    network: {
      interactive: createLane(),
      status: createLane(),
      background: createLane()
    }
  }
  private readonly countsByBudget = new Map<string, number>()
  private totalCount = 0

  get count(): number {
    return this.totalCount
  }

  enqueue(waiter: AdmissionWaiter): void {
    const lane = this.lanes[waiter.admissionClass][waiter.tier]
    lane.items.push(waiter)
    lane.count += 1
    this.totalCount += 1
    for (const key of waiter.budgetKeys) {
      this.countsByBudget.set(key, (this.countsByBudget.get(key) ?? 0) + 1)
    }
  }

  dequeue(waiter: AdmissionWaiter): void {
    const lane = this.lanes[waiter.admissionClass][waiter.tier]
    lane.count -= 1
    this.totalCount -= 1
    for (const key of waiter.budgetKeys) {
      const current = this.countsByBudget.get(key)
      if (current === 1) {
        this.countsByBudget.delete(key)
      } else if (current !== undefined) {
        this.countsByBudget.set(key, current - 1)
      }
    }
    this.compact(lane)
  }

  hasBudget(key: string): boolean {
    return this.countsByBudget.has(key)
  }

  snapshot(): AdmissionWaiter[] {
    return (['general', 'network'] as const)
      .flatMap((admissionClass) =>
        TIERS.flatMap((tier) => {
          const lane = this.lanes[admissionClass][tier]
          return lane.items.slice(lane.head).filter((waiter) => waiter.state === 'queued')
        })
      )
      .sort((left, right) => left.id - right.id)
  }

  nextFitting(
    admissionClass: AdmissionClass,
    effectiveTier: (waiter: AdmissionWaiter) => number,
    slotKindFor: (waiter: AdmissionWaiter) => AdmissionSlotKind | null,
    abort: (waiter: AdmissionWaiter) => void
  ): SelectedWaiter | null {
    let selected: (SelectedWaiter & { tier: number }) | null = null
    for (const rawTier of TIERS) {
      const lane = this.lanes[admissionClass][rawTier]
      for (let index = lane.head; index < lane.items.length; index += 1) {
        const waiter = lane.items[index]
        if (waiter.state !== 'queued') {
          continue
        }
        if (waiter.signal?.aborted) {
          abort(waiter)
          continue
        }
        const slotKind = slotKindFor(waiter)
        if (!slotKind) {
          continue
        }
        const tier = effectiveTier(waiter)
        if (
          !selected ||
          tier < selected.tier ||
          (tier === selected.tier && waiter.id < selected.waiter.id)
        ) {
          selected = { waiter, slotKind, tier }
        }
        break
      }
    }
    return selected
  }

  private compact(lane: WaiterLane): void {
    let head = lane.head
    while (head < lane.items.length && lane.items[head].state !== 'queued') {
      head += 1
    }
    lane.head = head
    if (lane.count === 0) {
      lane.items.length = 0
      lane.head = 0
      return
    }
    const tombstones = lane.items.length - head - lane.count
    if (head < 256 && (lane.items.length < 256 || tombstones <= lane.count)) {
      return
    }
    lane.items = lane.items.slice(head).filter((candidate) => candidate.state === 'queued')
    lane.head = 0
  }
}
