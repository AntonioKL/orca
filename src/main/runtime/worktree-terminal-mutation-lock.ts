import { settleBeforeDeadline } from './settle-before-deadline'

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
}

type LockEntry = {
  activeSpawns: number
  activeSleep: boolean
  queue: Waiter[]
}

export const WORKTREE_TERMINAL_SLEEP_TIMEOUT_ERROR = 'terminal_worktree_sleep_timeout'

export class WorktreeTerminalMutationLock {
  private readonly entries = new Map<string, LockEntry>()

  /** Why exposed: entry deletion is the only thing keeping this map from
   *  becoming a per-worktree leak, so the tests assert on it directly. */
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

    let grant!: () => void
    const granted = new Promise<void>((resolve) => {
      grant = resolve
    })
    const waiter: Waiter = { kind, grant }
    entry.queue.push(waiter)

    try {
      await (deadline === undefined
        ? granted
        : settleBeforeDeadline(
            () => granted,
            undefined,
            deadline,
            new Error(WORKTREE_TERMINAL_SLEEP_TIMEOUT_ERROR)
          ))
    } catch (error) {
      // Why splice-then-drain: the caller timed out, so this node must never
      // acquire later and stop terminals behind its back. Removing it before
      // any other code can run (no await between the throw and here) is what
      // makes a grant-after-timeout unrepresentable, so no tombstone flag is
      // needed — a queued waiter is by construction still live.
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
    return !entry.queue.some((waiter) => waiter.kind === 'sleep')
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
    // Granting a sleep sets activeSleep, which ends the loop on the next test.
    while (!entry.activeSleep && entry.queue.length > 0) {
      const next = entry.queue[0]!
      if (next.kind === 'sleep' && entry.activeSpawns > 0) {
        break
      }
      entry.queue.shift()
      this.markActive(entry, next.kind)
      next.grant()
    }
    if (entry.activeSpawns === 0 && !entry.activeSleep && entry.queue.length === 0) {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key)
      }
    }
  }
}
