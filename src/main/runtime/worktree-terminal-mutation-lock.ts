/**
 * Per-worktree lock guarding terminal spawn against terminal sleep.
 *
 * Why shared/exclusive and not a FIFO mutex: the invariant is spawn-vs-sleep
 * exclusion, never spawn-vs-spawn. A plain queue made every tab of a
 * multi-tab worktree wait for its predecessors' whole spawn, so activating a
 * 4-tab worktree paid a 0/125/212/291ms staircase of pure queueing before the
 * daemon attach even started. Spawns now share the lock; sleep still excludes.
 *
 * Writer-preferring: once a sleep is waiting, later spawns queue behind it, so
 * a steady stream of spawns can never starve a sleep into its 12s deadline.
 */
export type WorktreeTerminalMutationKind = 'spawn' | 'sleep'

type Waiter = {
  kind: WorktreeTerminalMutationKind
  grant: () => void
  abandoned: boolean
}

type LockEntry = {
  activeSpawns: number
  activeSleep: boolean
  queue: Waiter[]
}

export const WORKTREE_TERMINAL_SLEEP_TIMEOUT_ERROR = 'terminal_worktree_sleep_timeout'

export class WorktreeTerminalMutationLock {
  private readonly entries = new Map<string, LockEntry>()

  /** Exposed for tests/diagnostics: no key may leak once fully released. */
  get trackedKeyCount(): number {
    return this.entries.size
  }

  async acquire(
    key: string,
    kind: WorktreeTerminalMutationKind,
    deadline?: number
  ): Promise<() => void> {
    const entry = this.entries.get(key) ?? { activeSpawns: 0, activeSleep: false, queue: [] }
    this.entries.set(key, entry)

    if (this.canGrantImmediately(entry, kind)) {
      this.markActive(entry, kind)
      return this.createRelease(key, entry, kind)
    }

    const waiter: Waiter = { kind, grant: () => {}, abandoned: false }
    const granted = new Promise<void>((resolve) => {
      waiter.grant = resolve
    })
    entry.queue.push(waiter)

    try {
      await waitForMutationGrant(granted, deadline)
    } catch (error) {
      // Why: the caller timed out, so this node must never acquire later and
      // stop terminals behind its back. Drop it and hand the turn onward.
      waiter.abandoned = true
      const index = entry.queue.indexOf(waiter)
      if (index !== -1) {
        entry.queue.splice(index, 1)
      }
      this.drain(key, entry)
      throw error
    }

    return this.createRelease(key, entry, kind)
  }

  private canGrantImmediately(entry: LockEntry, kind: WorktreeTerminalMutationKind): boolean {
    if (entry.activeSleep) {
      return false
    }
    if (kind === 'sleep') {
      return entry.activeSpawns === 0 && entry.queue.length === 0
    }
    // Writer preference: a queued sleep blocks later spawns from jumping it.
    return !entry.queue.some((waiter) => waiter.kind === 'sleep' && !waiter.abandoned)
  }

  private markActive(entry: LockEntry, kind: WorktreeTerminalMutationKind): void {
    if (kind === 'sleep') {
      entry.activeSleep = true
      return
    }
    entry.activeSpawns += 1
  }

  private createRelease(
    key: string,
    entry: LockEntry,
    kind: WorktreeTerminalMutationKind
  ): () => void {
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      if (kind === 'sleep') {
        entry.activeSleep = false
      } else {
        entry.activeSpawns = Math.max(0, entry.activeSpawns - 1)
      }
      this.drain(key, entry)
    }
  }

  private drain(key: string, entry: LockEntry): void {
    while (entry.queue.length > 0) {
      const next = entry.queue[0]!
      if (next.abandoned) {
        entry.queue.shift()
        continue
      }
      if (entry.activeSleep) {
        break
      }
      if (next.kind === 'sleep') {
        if (entry.activeSpawns > 0) {
          break
        }
        entry.queue.shift()
        entry.activeSleep = true
        next.grant()
        break
      }
      entry.queue.shift()
      entry.activeSpawns += 1
      next.grant()
    }
    if (entry.activeSpawns === 0 && !entry.activeSleep && entry.queue.length === 0) {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key)
      }
    }
  }
}

async function waitForMutationGrant(granted: Promise<void>, deadline?: number): Promise<void> {
  if (deadline === undefined) {
    await granted
    return
  }
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    throw new Error(WORKTREE_TERMINAL_SLEEP_TIMEOUT_ERROR)
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      granted,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(WORKTREE_TERMINAL_SLEEP_TIMEOUT_ERROR)),
          remainingMs
        )
      })
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}
