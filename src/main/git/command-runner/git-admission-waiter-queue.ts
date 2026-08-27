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
type TierLanes = Record<GitAdmissionTier, Map<string | null, WaiterLane>>
const createTierLanes = (): TierLanes => ({
  interactive: new Map(),
  status: new Map(),
  background: new Map()
})

export class GitAdmissionWaiterQueue {
  private readonly lanes: Record<AdmissionClass, TierLanes> = {
    general: createTierLanes(),
    network: createTierLanes()
  }
  private readonly countsByBudget = new Map<string, number>()
  private totalCount = 0

  get count(): number {
    return this.totalCount
  }

  enqueue(waiter: AdmissionWaiter): void {
    const lanes = this.lanes[waiter.admissionClass][waiter.tier]
    let lane = lanes.get(waiter.route)
    if (!lane) {
      lane = createLane()
      lanes.set(waiter.route, lane)
    }
    lane.items.push(waiter)
    lane.count += 1
    this.totalCount += 1
    for (const key of waiter.budgetKeys) {
      this.countsByBudget.set(key, (this.countsByBudget.get(key) ?? 0) + 1)
    }
  }

  dequeue(waiter: AdmissionWaiter): void {
    const lanes = this.lanes[waiter.admissionClass][waiter.tier]
    const lane = lanes.get(waiter.route)
    if (!lane) {
      return
    }
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
    if (lane.count === 0) {
      lanes.delete(waiter.route)
    }
  }

  hasBudget(key: string): boolean {
    return this.countsByBudget.has(key)
  }

  snapshot(): AdmissionWaiter[] {
    return (['general', 'network'] as const)
      .flatMap((admissionClass) =>
        TIERS.flatMap((tier) => {
          return [...this.lanes[admissionClass][tier].values()].flatMap((lane) =>
            lane.items.slice(lane.head).filter((waiter) => waiter.state === 'queued')
          )
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
      for (const lane of this.lanes[admissionClass][rawTier].values()) {
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
          if (slotKind) {
            const tier = effectiveTier(waiter)
            if (
              !selected ||
              tier < selected.tier ||
              (tier === selected.tier && waiter.id < selected.waiter.id)
            ) {
              selected = { waiter, slotKind, tier }
            }
          }
          // Every waiter in this route lane has the same budget shape, so a
          // blocked head proves the rest cannot fit either.
          break
        }
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
