import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Repo } from '../shared/repo-types'
import { getSafeRelativePath } from './git/worktree-symlink-detection'
import { assertDependencySeedPathNoSymlink } from './worktree-dependency-seed-path'

export const WORKTREE_DEPENDENCY_SEED_LOCKFILE_PATHS = [
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json'
] as const

export const WORKTREE_DEPENDENCY_SEED_DIRECTORY = '.orca-dependency-seeds'
export const WORKTREE_DEPENDENCY_SEED_MARKER = 'seed.json'
export const WORKTREE_DEPENDENCY_SEED_VERSION = 1

/** Keep setup fingerprints bounded even when a repository contains a huge lockfile. */
export const WORKTREE_DEPENDENCY_SEED_INPUT_MAX_BYTES = 32 * 1024 * 1024

export type DependencySeedInputFile = {
  path: string
  bytes: Uint8Array | string
}

export type DependencySeedInputDigest = {
  path: string
  sha256: string
  byteLength: number
}

export type WorktreeDependencySeedFingerprint = {
  version: typeof WORKTREE_DEPENDENCY_SEED_VERSION
  digest: string
  setupScriptSha256: string
  lockfiles: readonly DependencySeedInputDigest[]
  platform: NodeJS.Platform
  architecture: string
  nodeMajor: number
  seedPaths: readonly string[]
}

export type WorktreeDependencySeedFingerprintInput = {
  setupScript: string
  lockfiles: readonly DependencySeedInputFile[]
  platform?: NodeJS.Platform
  architecture?: string
  nodeMajor?: number | string
  seedPaths?: readonly string[]
}

export type WorktreeDependencySeedRepo =
  | Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>
  | string

function normalizeNodeMajor(value: number | string | undefined): number {
  if (value === undefined) {
    const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
    return Number.isInteger(major) && major > 0 ? major : 0
  }
  const major = typeof value === 'number' ? value : Number.parseInt(value, 10)
  return Number.isInteger(major) && major >= 0 ? major : 0
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function byteLength(value: Uint8Array | string): number {
  return typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength
}

/** Whether an explicitly supplied input is safe to include in a seed identity. */
export function isValidDependencySeedInput(input: unknown): input is DependencySeedInputFile {
  if (!input || typeof input !== 'object') {
    return false
  }
  const candidate = input as Partial<DependencySeedInputFile>
  return (
    normalizeDependencySeedPath(candidate.path ?? '') !== null &&
    (typeof candidate.bytes === 'string' || candidate.bytes instanceof Uint8Array) &&
    byteLength(candidate.bytes) <= WORKTREE_DEPENDENCY_SEED_INPUT_MAX_BYTES
  )
}

export function normalizeDependencySeedPath(rawPath: string): string | null {
  if (typeof rawPath !== 'string' || rawPath.includes('\0')) {
    return null
  }
  const trimmed = rawPath.trim().replace(/\\/g, '/')
  // Seed identities are canonical: tolerate a leading `./` while preserving
  // the stricter rejection of dot segments in the middle of a path.
  const canonical = trimmed.replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '')
  // Check after stripping `./` too, so an absolute path cannot hide behind a
  // relative-looking prefix (for example, `./C:/outside`).
  if (canonical.startsWith('/') || /^[a-zA-Z]:/u.test(canonical)) {
    return null
  }
  const safe = getSafeRelativePath(canonical)
  if (!safe.safe) {
    return null
  }
  const segments = safe.rel.split('/')
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    segments.includes('.git') ||
    segments.includes(WORKTREE_DEPENDENCY_SEED_DIRECTORY) ||
    safe.rel === WORKTREE_DEPENDENCY_SEED_MARKER
  ) {
    return null
  }
  return segments.join('/')
}

/** Normalize and de-duplicate configured dependency paths. */
export function normalizeWorktreeDependencySeedPaths(paths: readonly string[]): string[] {
  if (!Array.isArray(paths)) {
    return []
  }
  const normalized = [
    ...new Set(
      paths.map(normalizeDependencySeedPath).filter((path): path is string => path !== null)
    )
  ].sort()
  // Cloning a parent already includes every child and avoids overlapping races.
  return normalized.filter(
    (path, index) => !normalized.slice(0, index).some((parent) => path.startsWith(`${parent}/`))
  )
}

/** Normalize exact root-relative input files without collapsing nested paths. */
export function normalizeWorktreeDependencySeedInputPaths(
  paths: readonly string[] | undefined
): string[] {
  const source = Array.isArray(paths) ? paths : []
  return [
    ...new Set(
      source.map(normalizeDependencySeedPath).filter((path): path is string => path !== null)
    )
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function normalizeFingerprintPaths(paths: readonly string[] | undefined): string[] {
  return normalizeWorktreeDependencySeedInputPaths(
    Array.isArray(paths) ? paths : WORKTREE_DEPENDENCY_SEED_LOCKFILE_PATHS
  )
}

function normalizeInputDigests(
  inputs: readonly DependencySeedInputFile[]
): DependencySeedInputDigest[] {
  const byPath = new Map<string, DependencySeedInputDigest>()
  if (!Array.isArray(inputs)) {
    return []
  }
  for (const input of inputs) {
    // Validate the untrusted shape before reading fields; callers may pass
    // persisted or IPC data rather than the static TypeScript type.
    if (!isValidDependencySeedInput(input)) {
      continue
    }
    const path = normalizeDependencySeedPath(input.path)
    if (!path) {
      continue
    }
    const bytes = input.bytes
    // Last-wins makes an explicitly supplied snapshot deterministic while
    // ensuring duplicate paths cannot produce duplicate marker entries.
    byPath.set(path, { path, sha256: sha256(bytes), byteLength: byteLength(bytes) })
  }
  // Keep descriptor ordering identical to the path normalizers and marker
  // validator; locale-sensitive ordering would reject valid case-sensitive
  // paths on different hosts.
  return [...byPath.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  )
}

/** Build the complete, inspectable fingerprint descriptor. */
export function createWorktreeDependencySeedFingerprint(
  input: WorktreeDependencySeedFingerprintInput
): WorktreeDependencySeedFingerprint {
  const platform = input.platform ?? process.platform
  const architecture = input.architecture ?? process.arch
  const nodeMajor = normalizeNodeMajor(input.nodeMajor)
  const seedPaths = normalizeWorktreeDependencySeedPaths(input.seedPaths ?? [])
  const lockfiles = normalizeInputDigests(input.lockfiles)
  const setupScriptSha256 = sha256(input.setupScript)
  const canonical = JSON.stringify({
    version: WORKTREE_DEPENDENCY_SEED_VERSION,
    setupScriptSha256,
    lockfiles,
    platform,
    architecture,
    nodeMajor,
    seedPaths
  })
  return {
    version: WORKTREE_DEPENDENCY_SEED_VERSION,
    digest: sha256(canonical),
    setupScriptSha256,
    lockfiles,
    platform,
    architecture,
    nodeMajor,
    seedPaths
  }
}

export function computeWorktreeDependencySeedFingerprint(
  input: WorktreeDependencySeedFingerprintInput
): string {
  return createWorktreeDependencySeedFingerprint(input).digest
}

export const createDependencySeedFingerprint = createWorktreeDependencySeedFingerprint
export const computeDependencySeedFingerprint = computeWorktreeDependencySeedFingerprint

/** Read all requested root-relative fingerprint inputs that exist in a checkout. */
export async function readWorktreeDependencySeedInputs(
  repoPath: string,
  paths: readonly string[] = WORKTREE_DEPENDENCY_SEED_LOCKFILE_PATHS
): Promise<DependencySeedInputFile[]> {
  const inputs: DependencySeedInputFile[] = []
  for (const path of normalizeFingerprintPaths(paths)) {
    const root = resolve(repoPath)
    const resolvedPath = resolve(root, path)
    const relativePath = relative(root, resolvedPath)
    if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
      continue
    }
    try {
      await assertDependencySeedPathNoSymlink(root, resolvedPath)
      const info = await lstat(resolvedPath)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > WORKTREE_DEPENDENCY_SEED_INPUT_MAX_BYTES
      ) {
        throw new Error(`Dependency seed input is not a regular bounded file: ${path}`)
      }
      const bytes = await readFile(resolvedPath)
      // A concurrent replacement should not let a symlink or an oversized file
      // sneak into the snapshot after the initial metadata check.
      const after = await lstat(resolvedPath)
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.size !== bytes.byteLength ||
        after.dev !== info.dev ||
        after.ino !== info.ino
      ) {
        throw new Error(`Dependency seed input changed while it was read: ${path}`)
      }
      inputs.push({ path, bytes })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }
  return inputs
}

function repoPathOf(repo: WorktreeDependencySeedRepo): string {
  return typeof repo === 'string' ? repo : repo.path
}

/** Resolve a sibling store, keyed by the canonical primary checkout path. */
export function getWorktreeDependencySeedRoot(
  repo: WorktreeDependencySeedRepo,
  worktreePath: string,
  explicitRoot?: string
): string {
  if (explicitRoot) {
    return explicitRoot
  }
  const repoKey = sha256(resolve(repoPathOf(repo))).slice(0, 32)
  return join(dirname(resolve(worktreePath)), WORKTREE_DEPENDENCY_SEED_DIRECTORY, repoKey)
}
