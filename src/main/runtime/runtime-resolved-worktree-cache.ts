import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'

export type ResolvedWorktreeSnapshot = {
  worktrees: ResolvedWorktree[]
  platformByRepoId: ReadonlyMap<string, NodeJS.Platform>
}

type ResolvedCache = ResolvedWorktreeSnapshot & { expiresAt: number }
type ResolvedInFlight = {
  generation: number
  promise: Promise<ResolvedWorktreeSnapshot>
}
type ScanCache = {
  generation: number
  runtimeKey: string
  result: RuntimeWorktreeScanResult
  expiresAt: number
}
type ScanInFlight = {
  generation: number
  runtimeKey: string
  promise: Promise<RuntimeWorktreeScanResult>
}

export class RuntimeResolvedWorktreeCache {
  private resolved: ResolvedCache | null = null
  private resolvedInFlight: ResolvedInFlight | null = null
  private resolvedGeneration = 0
  private readonly scanGenerations = new Map<string, number>()
  private readonly scans = new Map<string, ScanCache>()
  private readonly scansInFlight = new Map<string, ScanInFlight>()

  peek(): ResolvedCache | null {
    return this.resolved
  }

  async getSnapshot(
    compute: () => Promise<ResolvedWorktreeSnapshot>,
    ttlMs: number
  ): Promise<ResolvedWorktreeSnapshot> {
    const now = Date.now()
    if (this.resolved && this.resolved.expiresAt > now) {
      return this.resolved
    }
    const generation = this.resolvedGeneration
    if (this.resolvedInFlight?.generation === generation) {
      return this.resolvedInFlight.promise
    }
    const promise = compute()
    this.resolvedInFlight = { generation, promise }
    try {
      const result = await promise
      if (generation === this.resolvedGeneration) {
        this.resolved = { ...result, expiresAt: now + ttlMs }
      }
      return result
    } finally {
      if (this.resolvedInFlight?.promise === promise) {
        this.resolvedInFlight = null
      }
    }
  }

  async scan(
    repoId: string,
    runtimeKey: string,
    isRemote: boolean,
    load: () => Promise<RuntimeWorktreeScanResult>,
    ttlMs: number
  ): Promise<RuntimeWorktreeScanResult> {
    const now = Date.now()
    const generation = this.scanGenerations.get(repoId) ?? 0
    const cached = this.scans.get(repoId)
    if (
      cached?.generation === generation &&
      cached.runtimeKey === runtimeKey &&
      cached.expiresAt > now
    ) {
      return cached.result
    }
    const inFlight = this.scansInFlight.get(repoId)
    if (inFlight?.generation === generation && inFlight.runtimeKey === runtimeKey) {
      return inFlight.promise
    }
    const promise = load()
    this.scansInFlight.set(repoId, { generation, runtimeKey, promise })
    try {
      const result = await promise
      if (
        (result.ok || !isRemote) &&
        generation === (this.scanGenerations.get(repoId) ?? 0) &&
        this.scansInFlight.get(repoId)?.promise === promise
      ) {
        this.scans.set(repoId, {
          generation,
          runtimeKey,
          result,
          expiresAt: Date.now() + ttlMs
        })
      }
      return result
    } finally {
      if (this.scansInFlight.get(repoId)?.promise === promise) {
        this.scansInFlight.delete(repoId)
      }
    }
  }

  invalidateResolved(): void {
    this.resolvedGeneration += 1
    this.resolved = null
  }

  invalidateScan(repoId: string): void {
    this.scanGenerations.set(repoId, (this.scanGenerations.get(repoId) ?? 0) + 1)
    this.scans.delete(repoId)
    this.scansInFlight.delete(repoId)
  }
}
