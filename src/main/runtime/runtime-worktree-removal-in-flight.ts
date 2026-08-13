import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'

type RemovalResult = RemoveWorktreeResult & { warning?: string }

export class RuntimeWorktreeRemovalInFlight {
  private readonly removals = new Map<
    string,
    { optionsKey: string; promise: Promise<RemovalResult> }
  >()

  get(worktreeId: string, optionsKey: string): Promise<RemovalResult> | null {
    const removal = this.removals.get(worktreeId)
    if (!removal) {
      return null
    }
    if (removal.optionsKey === optionsKey) {
      return removal.promise
    }
    throw new Error(`Worktree deletion already in progress: ${worktreeId}`)
  }

  track(worktreeId: string, optionsKey: string, promise: Promise<RemovalResult>): void {
    this.removals.set(worktreeId, { optionsKey, promise })
  }

  release(worktreeId: string, promise: Promise<RemovalResult>): void {
    if (this.removals.get(worktreeId)?.promise === promise) {
      this.removals.delete(worktreeId)
    }
  }
}
