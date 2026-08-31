import {
  dependencySeedMarkerMatchesFingerprint,
  dependencySeedMarkerEntriesUsable,
  dependencySeedMarkerPaths,
  readDependencySeedMarker
} from './worktree-dependency-seed-marker'
import { cloneDependencySeedPath, dependencySeedPathExists } from './worktree-dependency-seed-clone'
import {
  createDependencySeedContext,
  ensureDependencySeedRoot,
  type SeedContext,
  type WorktreeDependencySeedArgs,
  type WorktreeDependencySeedResult
} from './worktree-dependency-seed-context'
import { withWorktreeDependencySeedLock } from './worktree-dependency-seed-lock'
import { cleanupDependencySeedCrashLeftovers } from './worktree-dependency-seed-promotion'
import { join } from 'node:path'

export {
  WORKTREE_DEPENDENCY_SEED_DIRECTORY,
  WORKTREE_DEPENDENCY_SEED_MARKER,
  WORKTREE_DEPENDENCY_SEED_LOCKFILE_PATHS,
  WORKTREE_DEPENDENCY_SEED_VERSION,
  createDependencySeedFingerprint,
  createWorktreeDependencySeedFingerprint,
  computeDependencySeedFingerprint,
  computeWorktreeDependencySeedFingerprint,
  getWorktreeDependencySeedRoot,
  isValidDependencySeedInput,
  normalizeDependencySeedPath,
  normalizeWorktreeDependencySeedInputPaths,
  normalizeWorktreeDependencySeedPaths,
  readWorktreeDependencySeedInputs
} from './worktree-dependency-seed-fingerprint'
export {
  cloneDependencySeedPath,
  defaultWorktreeDependencySeedDependencies,
  dependencySeedPathExists,
  dependencySeedSameDevice,
  removeDependencySeedEntry
} from './worktree-dependency-seed-clone'
export {
  dependencySeedMarkerMatchesFingerprint,
  dependencySeedMarkerPaths,
  readDependencySeedMarker
} from './worktree-dependency-seed-marker'
export { withWorktreeDependencySeedLock } from './worktree-dependency-seed-lock'
export {
  createDependencySeedContext,
  ensureDependencySeedRoot
} from './worktree-dependency-seed-context'
export {
  assertDependencySeedPathNoSymlink,
  ensureDependencySeedDirectory
} from './worktree-dependency-seed-path'
export { promoteWorktreeDependencySeed } from './worktree-dependency-seed-promotion'
export { cleanupDependencySeedCrashLeftovers } from './worktree-dependency-seed-promotion'
export {
  resolveWorktreeDependencySeedPlan,
  type WorktreeDependencySeedPlan
} from './worktree-dependency-seed-plan'
export type {
  DependencySeedInputDigest,
  DependencySeedInputFile,
  WorktreeDependencySeedFingerprint,
  WorktreeDependencySeedFingerprintInput,
  WorktreeDependencySeedRepo
} from './worktree-dependency-seed-fingerprint'
export type {
  DependencySeedProcessRunner,
  WorktreeDependencySeedDependencies
} from './worktree-dependency-seed-clone'
export type {
  SeedContext,
  WorktreeDependencySeedArgs,
  WorktreeDependencySeedOptions,
  WorktreeDependencySeedResult
} from './worktree-dependency-seed-context'

async function hydrateContext(context: SeedContext): Promise<WorktreeDependencySeedResult> {
  await ensureDependencySeedRoot(context)
  await cleanupDependencySeedCrashLeftovers(context.seedRoot)
  const marker = await readDependencySeedMarker(context.seedEntryPath)
  if (!marker || !dependencySeedMarkerMatchesFingerprint(marker, context.fingerprint)) {
    return { status: 'miss', fingerprint: context.fingerprint.digest, paths: [] }
  }
  if (!(await dependencySeedMarkerEntriesUsable(context.seedEntryPath, marker))) {
    return { status: 'miss', fingerprint: context.fingerprint.digest, paths: [] }
  }
  const markerPaths = dependencySeedMarkerPaths(marker, context.paths)
  if (markerPaths.length === 0) {
    return { status: 'miss', fingerprint: context.fingerprint.digest, paths: [] }
  }
  const hydrated: string[] = []
  for (const path of markerPaths) {
    const source = join(context.seedEntryPath, path)
    const target = join(context.worktreePath, path)
    try {
      // A marker is published only after every listed path is cloned. Treat a
      // later missing source as a cache miss instead of reporting `existing`
      // and silently accepting a partial/tampered seed.
      if (!(await dependencySeedPathExists(source))) {
        return { status: 'miss', fingerprint: context.fingerprint.digest, paths: [] }
      }
      if (await dependencySeedPathExists(target)) {
        continue
      }
      const result = await cloneDependencySeedPath(
        source,
        target,
        context.platform,
        context.dependencies,
        context.worktreePath,
        context.seedEntryPath
      )
      if (result === 'cloned') {
        hydrated.push(path)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw error
    }
  }
  return {
    status: hydrated.length > 0 ? 'hydrated' : 'existing',
    fingerprint: context.fingerprint.digest,
    paths: hydrated
  }
}

/** Hydrate a newly-created worktree from a matching private CoW seed, fail-open. */
export async function hydrateWorktreeDependencies(
  args: WorktreeDependencySeedArgs
): Promise<WorktreeDependencySeedResult> {
  try {
    const context = await createDependencySeedContext(args)
    if (!context) {
      return { status: 'skipped', paths: [], reason: 'unsupported-platform-or-repository' }
    }
    return await withWorktreeDependencySeedLock(
      context.seedEntryPath,
      () => hydrateContext(context),
      context.seedRoot
    )
  } catch (error) {
    console.warn('[worktree-dependency-seed] hydration skipped:', error)
    return {
      status: 'failed',
      paths: [],
      reason: error instanceof Error ? error.message : 'hydration-failed'
    }
  }
}

export type { DependencySeedMarker } from './worktree-dependency-seed-marker'
