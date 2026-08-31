import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  WORKTREE_DEPENDENCY_SEED_INPUT_MAX_BYTES,
  WORKTREE_DEPENDENCY_SEED_MARKER,
  WORKTREE_DEPENDENCY_SEED_VERSION,
  normalizeWorktreeDependencySeedPaths,
  type WorktreeDependencySeedFingerprint
} from './worktree-dependency-seed-fingerprint'
import {
  assertDependencySeedPathComponentsNoSymlink,
  assertDependencySeedPathNoSymlink
} from './worktree-dependency-seed-path'
import { assertDependencySeedTreeNoExternalSymlinks } from './worktree-dependency-seed-clone'

const MAX_MARKER_BYTES = 256 * 1024

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function isCanonicalSeedPath(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  return normalizeWorktreeDependencySeedPaths([value])[0] === value
}

function hasUniqueCanonicalPaths(paths: readonly unknown[]): paths is readonly string[] {
  if (!paths.every(isCanonicalSeedPath)) {
    return false
  }
  return new Set(paths).size === paths.length
}

function hasCanonicalSortedPaths(paths: readonly string[]): boolean {
  // Match Array#sort's deterministic UTF-16 ordering used by fingerprints;
  // localeCompare varies by host locale and can reject valid markers.
  return paths.every((path, index) => index === 0 || paths[index - 1]! < path)
}

function isCanonicalPathList(paths: readonly unknown[]): paths is readonly string[] {
  if (!hasUniqueCanonicalPaths(paths)) {
    return false
  }
  const normalized = normalizeWorktreeDependencySeedPaths(paths)
  return (
    normalized.length === paths.length &&
    hasCanonicalSortedPaths(paths) &&
    normalized.every((path, index) => paths[index] === path)
  )
}

function fingerprintDigest(fingerprint: WorktreeDependencySeedFingerprint): string {
  const canonical = JSON.stringify({
    version: fingerprint.version,
    setupScriptSha256: fingerprint.setupScriptSha256,
    lockfiles: fingerprint.lockfiles.map(({ path, sha256, byteLength }) => ({
      path,
      sha256,
      byteLength
    })),
    platform: fingerprint.platform,
    architecture: fingerprint.architecture,
    nodeMajor: fingerprint.nodeMajor,
    seedPaths: [...fingerprint.seedPaths]
  })
  return createHash('sha256').update(canonical).digest('hex')
}

export type DependencySeedMarker = {
  version: typeof WORKTREE_DEPENDENCY_SEED_VERSION
  fingerprint: WorktreeDependencySeedFingerprint
  /** Paths copied into this particular seed (a declared path may be absent). */
  paths: readonly string[]
  createdAt: string
}

function isFingerprintShape(value: unknown): value is WorktreeDependencySeedFingerprint {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<WorktreeDependencySeedFingerprint>
  const lockfiles = candidate.lockfiles
  const seedPaths = candidate.seedPaths
  if (!Array.isArray(lockfiles) || !Array.isArray(seedPaths)) {
    return false
  }
  const lockfilePaths = lockfiles.map((entry) =>
    entry && typeof entry === 'object' ? (entry as { path?: unknown }).path : undefined
  )
  const validLockfileEntries = lockfiles.every(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      isCanonicalSeedPath((entry as { path?: unknown }).path) &&
      isSha256((entry as { sha256?: unknown }).sha256) &&
      Number.isSafeInteger((entry as { byteLength?: unknown }).byteLength) &&
      ((entry as { byteLength: number }).byteLength ?? -1) >= 0 &&
      ((entry as { byteLength: number }).byteLength ?? Infinity) <=
        WORKTREE_DEPENDENCY_SEED_INPUT_MAX_BYTES
  )
  const validSeedPaths =
    hasUniqueCanonicalPaths(seedPaths) &&
    hasCanonicalSortedPaths(seedPaths) &&
    normalizeWorktreeDependencySeedPaths(seedPaths).length === seedPaths.length &&
    normalizeWorktreeDependencySeedPaths(seedPaths).every(
      (path, index) => seedPaths[index] === path
    )
  return (
    candidate.version === WORKTREE_DEPENDENCY_SEED_VERSION &&
    isSha256(candidate.digest) &&
    isSha256(candidate.setupScriptSha256) &&
    validLockfileEntries &&
    lockfilePaths.every((path): path is string => typeof path === 'string') &&
    hasCanonicalSortedPaths(lockfilePaths) &&
    typeof candidate.platform === 'string' &&
    candidate.platform.length > 0 &&
    typeof candidate.architecture === 'string' &&
    candidate.architecture.length > 0 &&
    typeof candidate.nodeMajor === 'number' &&
    Number.isSafeInteger(candidate.nodeMajor) &&
    candidate.nodeMajor >= 0 &&
    validSeedPaths &&
    candidate.digest === fingerprintDigest(candidate as WorktreeDependencySeedFingerprint)
  )
}

export async function readDependencySeedMarker(path: string): Promise<DependencySeedMarker | null> {
  try {
    await assertDependencySeedPathComponentsNoSymlink(path)
    const directoryStats = await lstat(path)
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      return null
    }
    const markerPath = join(path, WORKTREE_DEPENDENCY_SEED_MARKER)
    const markerStats = await lstat(markerPath)
    if (
      !markerStats.isFile() ||
      markerStats.isSymbolicLink() ||
      markerStats.size > MAX_MARKER_BYTES
    ) {
      return null
    }
    const parsed: unknown = JSON.parse(await readFile(markerPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') {
      return null
    }
    const marker = parsed as Partial<DependencySeedMarker>
    const markerFingerprint = marker.fingerprint
    if (
      marker.version !== WORKTREE_DEPENDENCY_SEED_VERSION ||
      typeof marker.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(marker.createdAt)) ||
      !isFingerprintShape(markerFingerprint) ||
      !Array.isArray(marker.paths) ||
      marker.paths.length === 0 ||
      !isCanonicalPathList(marker.paths)
    ) {
      return null
    }
    if (marker.paths.some((path) => !markerFingerprint.seedPaths.includes(path))) {
      return null
    }
    return marker as DependencySeedMarker
  } catch {
    return null
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

export function dependencySeedMarkerMatchesFingerprint(
  marker: DependencySeedMarker,
  fingerprint: WorktreeDependencySeedFingerprint
): boolean {
  if (!marker || typeof marker !== 'object' || !fingerprint || typeof fingerprint !== 'object') {
    return false
  }
  if (!isFingerprintShape(marker.fingerprint) || !isFingerprintShape(fingerprint)) {
    return false
  }
  return (
    marker.fingerprint.digest === fingerprint.digest &&
    marker.fingerprint.version === fingerprint.version &&
    marker.fingerprint.setupScriptSha256 === fingerprint.setupScriptSha256 &&
    marker.fingerprint.platform === fingerprint.platform &&
    marker.fingerprint.architecture === fingerprint.architecture &&
    marker.fingerprint.nodeMajor === fingerprint.nodeMajor &&
    sameStringArray(marker.fingerprint.seedPaths, fingerprint.seedPaths) &&
    sameStringArray(
      marker.fingerprint.lockfiles.map((entry) => entry.path),
      fingerprint.lockfiles.map((entry) => entry.path)
    ) &&
    marker.fingerprint.lockfiles.every(
      (entry, index) =>
        entry.sha256 === fingerprint.lockfiles[index]?.sha256 &&
        entry.byteLength === fingerprint.lockfiles[index]?.byteLength
    )
  )
}

export function dependencySeedMarkerPaths(
  marker: DependencySeedMarker,
  declaredPaths: readonly string[]
): string[] {
  if (!marker || typeof marker !== 'object' || !Array.isArray(declaredPaths)) {
    return []
  }
  const markerPaths = Array.isArray(marker.paths) ? marker.paths.filter(isCanonicalSeedPath) : []
  const normalized = normalizeWorktreeDependencySeedPaths(markerPaths)
  const declared = normalizeWorktreeDependencySeedPaths(
    declaredPaths.filter((path): path is string => typeof path === 'string')
  )
  return normalized.filter((path) => declared.includes(path))
}

/** Verify that every top-level path named by a marker still exists as a real entry. */
export async function dependencySeedMarkerEntriesUsable(
  entryRoot: string,
  marker: DependencySeedMarker
): Promise<boolean> {
  if (!marker || typeof marker !== 'object' || !Array.isArray(marker.paths)) {
    return false
  }
  for (const path of marker.paths) {
    const source = resolve(entryRoot, path)
    try {
      await assertDependencySeedPathNoSymlink(entryRoot, source)
      const stats = await lstat(source)
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
        return false
      }
      await assertDependencySeedTreeNoExternalSymlinks(source)
    } catch {
      return false
    }
  }
  return true
}
