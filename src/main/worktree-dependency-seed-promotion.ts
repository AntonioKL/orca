import { lstat, mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  WORKTREE_DEPENDENCY_SEED_MARKER,
  WORKTREE_DEPENDENCY_SEED_VERSION
} from './worktree-dependency-seed-fingerprint'
import {
  cloneDependencySeedPath,
  dependencySeedPathExists,
  removeDependencySeedEntry
} from './worktree-dependency-seed-clone'
import {
  createDependencySeedContext,
  ensureDependencySeedRoot,
  type SeedContext,
  type WorktreeDependencySeedArgs,
  type WorktreeDependencySeedResult
} from './worktree-dependency-seed-context'
import {
  dependencySeedMarkerMatchesFingerprint,
  dependencySeedMarkerEntriesUsable,
  readDependencySeedMarker,
  type DependencySeedMarker
} from './worktree-dependency-seed-marker'
import { withWorktreeDependencySeedLock } from './worktree-dependency-seed-lock'

async function promoteContext(
  context: SeedContext,
  replaceExisting: boolean
): Promise<WorktreeDependencySeedResult> {
  await ensureDependencySeedRoot(context)
  await cleanupDependencySeedCrashLeftovers(context.seedRoot)
  const existingMarker = await readDependencySeedMarker(context.seedEntryPath)
  if (
    existingMarker &&
    dependencySeedMarkerMatchesFingerprint(existingMarker, context.fingerprint) &&
    context.paths.every((path) => existingMarker.paths.includes(path)) &&
    (await dependencySeedMarkerEntriesUsable(context.seedEntryPath, existingMarker)) &&
    !replaceExisting
  ) {
    return { status: 'existing', fingerprint: context.fingerprint.digest, paths: [] }
  }

  const stagingPath = join(
    context.seedRoot,
    `.staging-${process.pid}-${context.dependencies.randomUUID()}`
  )
  await mkdir(stagingPath)
  const stagedPaths: string[] = []
  try {
    for (const path of context.paths) {
      const source = resolve(context.worktreePath, path)
      const target = resolve(stagingPath, path)
      try {
        const sourceEntry = await lstat(source)
        if (sourceEntry.isSymbolicLink()) {
          continue
        }
        const result = await cloneDependencySeedPath(
          source,
          target,
          context.platform,
          context.dependencies,
          stagingPath,
          context.worktreePath
        )
        if (result === 'cloned') {
          stagedPaths.push(path)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue
        }
        throw error
      }
    }
    if (stagedPaths.length === 0) {
      return {
        status: 'skipped',
        fingerprint: context.fingerprint.digest,
        paths: [],
        reason: 'no-dependency-paths'
      }
    }
    const marker: DependencySeedMarker = {
      version: WORKTREE_DEPENDENCY_SEED_VERSION,
      fingerprint: context.fingerprint,
      paths: stagedPaths,
      createdAt: new Date().toISOString()
    }
    await writeFile(
      join(stagingPath, WORKTREE_DEPENDENCY_SEED_MARKER),
      `${JSON.stringify(marker, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' }
    )

    let backupPath: string | undefined
    if (await dependencySeedPathExists(context.seedEntryPath)) {
      backupPath = join(
        context.seedRoot,
        `.stale-${context.dependencies.randomUUID()}-${context.fingerprint.digest}`
      )
      await rename(context.seedEntryPath, backupPath)
    }
    try {
      await rename(stagingPath, context.seedEntryPath)
    } catch (error) {
      if (backupPath) {
        await rename(backupPath, context.seedEntryPath).catch(() => {})
      }
      throw error
    }
    if (backupPath) {
      await removeDependencySeedEntry(backupPath).catch(() => {})
    }
    await pruneDependencySeedEntries(context)
    return { status: 'promoted', fingerprint: context.fingerprint.digest, paths: stagedPaths }
  } finally {
    await removeDependencySeedEntry(stagingPath).catch(() => {})
  }
}

const MAX_RETAINED_DEPENDENCY_SEEDS = 8

/** Remove staging/backup entries left by a process that crashed mid-publish. */
export async function cleanupDependencySeedCrashLeftovers(seedRoot: string): Promise<void> {
  const entries = await readdir(seedRoot, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (!entries) {
    return
  }
  for (const entry of entries) {
    // The current publisher prefixes backups with `.stale-`; accept the old
    // `<digest>.stale-...` form too so upgrades do not retain crash debris.
    const isStaleBackup =
      entry.name.startsWith('.stale-') || /^[0-9a-f]{64}\.stale-/u.test(entry.name)
    if (!entry.name.startsWith('.staging-') && !isStaleBackup) {
      continue
    }
    await removeDependencySeedEntry(join(seedRoot, entry.name)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    })
  }
}

/** Remove only old, valid generated entries; unknown files remain untouched. */
async function pruneDependencySeedEntries(context: SeedContext): Promise<void> {
  const entries = await readdir(context.seedRoot, { withFileTypes: true })
  const candidates: { path: string; createdAt: number }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue
    }
    const entryPath = join(context.seedRoot, entry.name)
    const marker = await readDependencySeedMarker(entryPath)
    if (
      !marker ||
      entry.name !== marker.fingerprint.digest ||
      !dependencySeedMarkerMatchesFingerprint(marker, marker.fingerprint)
    ) {
      continue
    }
    const createdAt = Date.parse(marker.createdAt)
    candidates.push({ path: entryPath, createdAt: Number.isFinite(createdAt) ? createdAt : 0 })
  }
  const retained = candidates
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_RETAINED_DEPENDENCY_SEEDS)
  const retainedPaths = new Set(retained.map((entry) => entry.path))
  for (const candidate of candidates) {
    if (candidate.path === context.seedEntryPath || retainedPaths.has(candidate.path)) {
      continue
    }
    await removeDependencySeedEntry(candidate.path).catch(() => {})
  }
}

/** Promote a successfully-installed worktree into the local seed store. */
export async function promoteWorktreeDependencySeed(
  args: WorktreeDependencySeedArgs
): Promise<WorktreeDependencySeedResult> {
  try {
    const context = await createDependencySeedContext(args)
    if (!context) {
      return { status: 'skipped', paths: [], reason: 'unsupported-platform-or-repository' }
    }
    return await withWorktreeDependencySeedLock(
      context.seedEntryPath,
      () => promoteContext(context, args.replaceExisting === true),
      context.seedRoot
    )
  } catch (error) {
    console.warn('[worktree-dependency-seed] promotion skipped:', error)
    return {
      status: 'failed',
      paths: [],
      reason: error instanceof Error ? error.message : 'promotion-failed'
    }
  }
}
