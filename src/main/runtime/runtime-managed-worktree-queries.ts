import type { DetectedWorktreeListResult, Worktree } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeWorktreeListResult } from '../../shared/runtime-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  applyMetadataFallbackVisibility,
  buildKnownOrcaWorkspaceLayouts,
  isLegacyRepoForExternalWorktreeVisibility,
  toDetectedWorktree
} from '../../shared/worktree/ownership'
import { projectResolvedWorktreeLineage } from '../../shared/resolved-worktree-lineage'
import {
  createWorktreeVisibilitySourceMatcher,
  normalizeCustomWorktreeVisibilitySources,
  type WorktreeVisibilitySourceMatcher
} from '../../shared/worktree/visibility-sources'
import { mergeWorktree } from '../ipc/worktree-logic'
import { pruneLineageForMissingRepoWorktrees } from '../worktree-lineage-pruning'
import type { Store } from '../persistence'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import { listRuntimeFolderWorkspaces } from './runtime-worktree-filesystem'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

type Dependencies = {
  getStore(): RuntimeStore | null
  listResolved(): Promise<ResolvedWorktree[]>
  resolveRepo(selector: string): Promise<Repo>
  selectRepos(selector: string): Repo[]
  scanRepo(repo: Repo): Promise<RuntimeWorktreeScanResult>
}

export class RuntimeManagedWorktreeQueries {
  constructor(private readonly deps: Dependencies) {}

  async list(repoSelector: string | undefined, limit: number): Promise<RuntimeWorktreeListResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const resolved = await this.deps.listResolved()
    const repoId = repoSelector ? (await this.deps.resolveRepo(repoSelector)).id : null
    const pathsByRepo = new Map<string, string[]>()
    for (const worktree of resolved) {
      const paths = pathsByRepo.get(worktree.repoId) ?? []
      paths.push(worktree.path)
      pathsByRepo.set(worktree.repoId, paths)
    }
    const matchers = new Map(
      (this.deps.getStore()?.getRepos() ?? []).map((repo) => [
        repo.id,
        createWorktreeVisibilitySourceMatcher(
          [repo.path, ...(pathsByRepo.get(repo.id) ?? [])],
          normalizeCustomWorktreeVisibilitySources(repo.customWorktreeVisibilitySources) ?? []
        )
      ])
    )
    const worktrees = resolved.filter(
      (worktree) =>
        (!repoId || worktree.repoId === repoId) &&
        this.isVisible(worktree, matchers.get(worktree.repoId))
    )
    return {
      worktrees: worktrees.slice(0, limit),
      totalCount: worktrees.length,
      truncated: worktrees.length > limit
    }
  }

  resolveRepoForConnection(selector: string, connectionId?: string | null): Promise<Repo> {
    if (connectionId === undefined) {
      return this.deps.resolveRepo(selector)
    }
    const wanted = connectionId?.trim() || null
    const matches = this.deps
      .selectRepos(selector)
      .filter((repo) => (repo.connectionId?.trim() || null) === wanted)
    if (matches.length !== 1) {
      throw new Error(matches.length > 1 ? 'selector_ambiguous' : 'repo_not_found')
    }
    return Promise.resolve(matches[0])
  }

  async listDetected(repo: Repo): Promise<DetectedWorktreeListResult> {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    if (isFolderRepo(repo)) {
      const worktrees = listRuntimeFolderWorkspaces(store, repo)
      const matcher = createWorktreeVisibilitySourceMatcher(
        [repo.path, ...worktrees.map((worktree) => worktree.path)],
        normalizeCustomWorktreeVisibilitySources(repo.customWorktreeVisibilitySources) ?? []
      )
      const detected = worktrees.map((worktree) => this.toDetected(repo, worktree, matcher))
      return {
        repoId: repo.id,
        authoritative: true,
        source: 'git',
        worktrees: projectResolvedWorktreeLineage(detected, store.getAllWorktreeLineage?.() ?? {})
      }
    }
    let scan: RuntimeWorktreeScanResult
    try {
      scan = await this.deps.scanRepo(repo)
    } catch {
      scan = { ok: false, worktrees: [] }
    }
    if (scan.ok) {
      pruneLineageForMissingRepoWorktrees(store as unknown as Store, repo, scan.worktrees)
    }
    const matcher = createWorktreeVisibilitySourceMatcher(
      [repo.path, ...scan.worktrees.map((worktree) => worktree.path)],
      normalizeCustomWorktreeVisibilitySources(repo.customWorktreeVisibilitySources) ?? []
    )
    const detected = scan.worktrees.map((gitWorktree) => {
      const id = `${repo.id}::${gitWorktree.path}`
      const meta = store.getWorktreeMeta(id)
      const worktree = {
        ...mergeWorktree(repo.id, gitWorktree, meta, repo.displayName),
        hostId: meta?.hostId ?? getRepoExecutionHostId(repo)
      }
      const result = this.toDetected(repo, worktree, matcher)
      return scan.ok ? result : applyMetadataFallbackVisibility(result)
    })
    return {
      repoId: repo.id,
      authoritative: scan.ok,
      source: scan.ok ? 'git' : 'metadata-fallback',
      worktrees: projectResolvedWorktreeLineage(detected, store.getAllWorktreeLineage?.() ?? {})
    }
  }

  isVisible(worktree: Worktree, matcher?: WorktreeVisibilitySourceMatcher): boolean {
    const repo = this.deps.getStore()?.getRepo(worktree.repoId)
    return repo ? this.toDetected(repo, worktree, matcher).visible : true
  }

  buildVisibilityMatchers(
    worktrees: readonly Worktree[]
  ): Map<string, WorktreeVisibilitySourceMatcher> {
    const checkoutPathsByRepoId = new Map<string, string[]>()
    for (const worktree of worktrees) {
      const checkoutPaths = checkoutPathsByRepoId.get(worktree.repoId) ?? []
      checkoutPaths.push(worktree.path)
      checkoutPathsByRepoId.set(worktree.repoId, checkoutPaths)
    }
    return new Map(
      (this.deps.getStore()?.getRepos() ?? [])
        .filter((repo) => checkoutPathsByRepoId.has(repo.id))
        .map((repo) => [
          repo.id,
          createWorktreeVisibilitySourceMatcher(
            [repo.path, ...(checkoutPathsByRepoId.get(repo.id) ?? [])],
            normalizeCustomWorktreeVisibilitySources(repo.customWorktreeVisibilitySources) ?? []
          )
        ])
    )
  }

  private toDetected(
    repo: Repo,
    worktree: Worktree,
    matcher?: WorktreeVisibilitySourceMatcher
  ) {
    const store = this.deps.getStore()
    const settings = store?.getSettings()
    if (!settings) {
      return {
        ...worktree,
        ownership: 'unknown-legacy' as const,
        selectedCheckout: false,
        visible: true
      }
    }
    return toDetectedWorktree({
      repo,
      worktree,
      meta: store?.getWorktreeMeta(worktree.id),
      settings,
      knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo),
      isLegacyRepoForVisibility: isLegacyRepoForExternalWorktreeVisibility(repo),
      worktreeVisibilitySourceMatcher: matcher
    })
  }
}
