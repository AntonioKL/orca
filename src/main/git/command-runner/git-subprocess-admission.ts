import { uncRouteKey } from '../../providers/working-directory-validation'
import { classifyGitCommand } from '../wsl-direct-git-read-commands'
import { createAbortError } from './abort-error'
import {
  ADMISSION_TIER_VALUE,
  AdmissionEventPublisher,
  DEFAULT_ADMISSION_SCHEDULER_CONFIG,
  type AdmissionBudget,
  type AdmissionClass,
  type AdmissionSchedulerConfig,
  type AdmissionSlotKind,
  type AdmissionWaiter,
  type GitAdmissionGrant,
  type GitAdmissionRequest
} from './git-admission-state'

export type {
  GitAdmissionEvent,
  GitAdmissionGrant,
  GitAdmissionRequest
} from './git-admission-state'
export {
  GENERAL_CAP,
  GENERAL_HEADROOM,
  GIT_ADMISSION_AGING_MS,
  MAX_GIT_CHILDREN,
  NETWORK_CAP,
  NETWORK_HEADROOM,
  ROUTE_CAP,
  ROUTE_HEADROOM
} from './git-admission-state'

function commandClass(args: readonly string[]): AdmissionClass {
  return classifyGitCommand(args) === 'network' ? 'network' : 'general'
}

function routeKey(request: GitAdmissionRequest): string | null {
  const distro = request.wslDistro?.trim().toLowerCase()
  return distro ? `wsl:${distro}` : uncRouteKey(request.cwd)
}

export class GitAdmissionScheduler {
  private readonly config: AdmissionSchedulerConfig
  private readonly budgets = new Map<string, AdmissionBudget>()
  private readonly waiters: AdmissionWaiter[] = []
  private nextWaiterId = 0
  private readonly eventPublisher: AdmissionEventPublisher

  constructor(config: Partial<AdmissionSchedulerConfig> = {}) {
    this.config = { ...DEFAULT_ADMISSION_SCHEDULER_CONFIG, ...config }
    this.eventPublisher = new AdmissionEventPublisher(this.config.onAdmissionEvent)
  }

  acquire(request: GitAdmissionRequest): Promise<GitAdmissionGrant> {
    if (request.signal?.aborted) {
      return Promise.reject(createAbortError())
    }
    const enqueuedAt = this.config.now()
    const { admissionClass, route, budgetKeys } = this.resolveBudgets(request)
    return new Promise<GitAdmissionGrant>((resolve, reject) => {
      const waiter: AdmissionWaiter = {
        id: this.nextWaiterId++,
        args: request.args,
        tier: request.tier ?? 'status',
        admissionClass,
        route,
        enqueuedAt,
        budgetKeys,
        signal: request.signal,
        state: 'queued',
        resolve,
        reject,
        onAbort: () => this.abort(waiter)
      }
      request.signal?.addEventListener('abort', waiter.onAbort, { once: true })
      if (request.signal?.aborted) {
        this.abort(waiter)
        return
      }
      this.waiters.push(waiter)
      this.drain()
    })
  }

  snapshot(): {
    queued: number
    queuedWaiters: { id: number; args: readonly string[]; tier: AdmissionWaiter['tier'] }[]
    budgets: Record<string, { baseUsed: number; headroomUsed: number }>
  } {
    const queuedWaiters = this.waiters.filter((waiter) => waiter.state === 'queued')
    return {
      queued: queuedWaiters.length,
      queuedWaiters: queuedWaiters.map(({ id, args, tier }) => ({ id, args, tier })),
      budgets: Object.fromEntries(
        [...this.budgets].map(([key, budget]) => [
          key,
          { baseUsed: budget.baseUsed, headroomUsed: budget.headroomUsed }
        ])
      )
    }
  }

  private resolveBudgets(request: GitAdmissionRequest): {
    admissionClass: AdmissionClass
    route: string | null
    budgetKeys: readonly string[]
  } {
    const admissionClass = commandClass(request.args)
    const route = routeKey(request)
    const keys: string[] = [admissionClass]
    if (route) {
      keys.push(`route:${admissionClass}:${route}`)
    }
    for (const key of keys) {
      this.ensureBudget(key)
    }
    return { admissionClass, route, budgetKeys: keys }
  }

  private ensureBudget(key: string): AdmissionBudget {
    let budget = this.budgets.get(key)
    if (budget) {
      return budget
    }
    const isRoute = key.startsWith('route:')
    const isNetwork = key === 'network'
    budget = {
      baseCapacity: isRoute
        ? this.config.routeCap
        : isNetwork
          ? this.config.networkCap
          : this.config.generalCap,
      headroomCapacity: isRoute
        ? this.config.routeHeadroom
        : isNetwork
          ? this.config.networkHeadroom
          : this.config.generalHeadroom,
      baseUsed: 0,
      headroomUsed: 0
    }
    this.budgets.set(key, budget)
    return budget
  }

  private effectiveTier(waiter: AdmissionWaiter, now: number): number {
    const promotions = Math.floor((now - waiter.enqueuedAt) / this.config.agingMs)
    return Math.max(0, ADMISSION_TIER_VALUE[waiter.tier] - promotions)
  }

  private fits(waiter: AdmissionWaiter, slotKind: AdmissionSlotKind): boolean {
    return waiter.budgetKeys.every((key) => {
      const budget = this.ensureBudget(key)
      return slotKind === 'base'
        ? budget.baseUsed < budget.baseCapacity
        : budget.headroomUsed < budget.headroomCapacity
    })
  }

  private drain(): void {
    let granted = true
    while (granted) {
      granted = false
      const now = this.config.now()
      const ordered = this.waiters
        .filter((waiter) => waiter.state === 'queued')
        .sort(
          (left, right) =>
            this.effectiveTier(left, now) - this.effectiveTier(right, now) || left.id - right.id
        )
      for (const waiter of ordered) {
        if (waiter.signal?.aborted) {
          this.abort(waiter)
          continue
        }
        const slotKind = this.fits(waiter, 'base')
          ? 'base'
          : waiter.tier === 'interactive' && this.fits(waiter, 'headroom')
            ? 'headroom'
            : null
        if (!slotKind) {
          continue
        }
        this.grant(waiter, slotKind, now)
        granted = true
      }
    }
    this.pruneBudgets()
  }

  private grant(waiter: AdmissionWaiter, slotKind: AdmissionSlotKind, now: number): void {
    waiter.state = 'granted'
    waiter.slotKind = slotKind
    for (const key of waiter.budgetKeys) {
      const budget = this.ensureBudget(key)
      if (slotKind === 'base') {
        budget.baseUsed += 1
      } else {
        budget.headroomUsed += 1
      }
    }
    const queueWaitMs = Math.max(0, now - waiter.enqueuedAt)
    this.publishEvent(waiter, slotKind, 'grant', queueWaitMs)
    queueMicrotask(() => {
      if (waiter.state !== 'granted') {
        return
      }
      waiter.state = 'settled'
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.resolve({
        queueWaitMs,
        release: this.releaseOnce(waiter, slotKind, queueWaitMs)
      })
      this.removeWaiter(waiter)
    })
  }

  private releaseOnce(
    waiter: AdmissionWaiter,
    slotKind: AdmissionSlotKind,
    queueWaitMs: number
  ): () => void {
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      for (const key of waiter.budgetKeys) {
        const budget = this.ensureBudget(key)
        if (slotKind === 'base') {
          budget.baseUsed -= 1
        } else {
          budget.headroomUsed -= 1
        }
      }
      this.publishEvent(waiter, slotKind, 'release', queueWaitMs)
      this.drain()
    }
  }

  private abort(waiter: AdmissionWaiter): void {
    if (waiter.state === 'settled') {
      return
    }
    if (waiter.state === 'granted' && waiter.slotKind) {
      this.releaseOnce(
        waiter,
        waiter.slotKind,
        Math.max(0, this.config.now() - waiter.enqueuedAt)
      )()
    }
    waiter.state = 'settled'
    waiter.signal?.removeEventListener('abort', waiter.onAbort)
    this.removeWaiter(waiter)
    waiter.reject(createAbortError())
    this.drain()
  }

  private removeWaiter(waiter: AdmissionWaiter): void {
    const index = this.waiters.indexOf(waiter)
    if (index !== -1) {
      this.waiters.splice(index, 1)
    }
  }

  private publishEvent(
    waiter: AdmissionWaiter,
    slotKind: AdmissionSlotKind,
    phase: 'grant' | 'release',
    queueWaitMs: number
  ): void {
    this.eventPublisher.publish({
      phase,
      waiter,
      slotKind,
      queueWaitMs,
      queued: this.waiters.filter((candidate) => candidate.state === 'queued').length,
      budgets: this.budgets
    })
  }

  private pruneBudgets(): void {
    const queuedKeys = new Set(
      this.waiters.flatMap((waiter) => (waiter.state === 'queued' ? waiter.budgetKeys : []))
    )
    for (const [key, budget] of this.budgets) {
      if (
        key.startsWith('route:') &&
        budget.baseUsed === 0 &&
        budget.headroomUsed === 0 &&
        !queuedKeys.has(key)
      ) {
        this.budgets.delete(key)
      }
    }
  }
}

let scheduler = new GitAdmissionScheduler()

export function acquireGitAdmission(request: GitAdmissionRequest): Promise<GitAdmissionGrant> {
  if (process.env.ORCA_GIT_ADMISSION_DISABLED === '1') {
    return Promise.resolve({ queueWaitMs: 0, release: () => {} })
  }
  return scheduler.acquire(request)
}

export function _resetGitAdmissionForTests(replacement = new GitAdmissionScheduler()): void {
  scheduler = replacement
}

export function _gitAdmissionSnapshotForTests(): ReturnType<GitAdmissionScheduler['snapshot']> {
  return scheduler.snapshot()
}
