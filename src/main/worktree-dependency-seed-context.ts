import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  DependencySeedInputFile,
  WorktreeDependencySeedFingerprint,
  WorktreeDependencySeedRepo
} from './worktree-dependency-seed-fingerprint'
import {
  WORKTREE_DEPENDENCY_SEED_LOCKFILE_PATHS,
  createWorktreeDependencySeedFingerprint,
  getWorktreeDependencySeedRoot,
  isValidDependencySeedInput,
  normalizeWorktreeDependencySeedPaths,
  readWorktreeDependencySeedInputs
} from './worktree-dependency-seed-fingerprint'
import {
  defaultWorktreeDependencySeedDependencies,
  dependencySeedSameDevice,
  type WorktreeDependencySeedDependencies
} from './worktree-dependency-seed-clone'
import {
  assertDependencySeedPathNoSymlink,
  ensureDependencySeedDirectory
} from './worktree-dependency-seed-path'

const LOCKFILE_REQUIRED_BY_DEFAULT = true

export type WorktreeDependencySeedOptions = {
  platform?: NodeJS.Platform
  architecture?: string
  nodeMajor?: number | string
  /** Exact root-relative files to hash. Defaults to package-manager lockfiles. */
  fingerprintPaths?: readonly string[]
  /** Explicit bytes avoid a second read and let callers hash a setup snapshot. */
  lockfiles?: readonly DependencySeedInputFile[]
  /** Keep the first successful tree for a digest unless explicitly replacing it. */
  replaceExisting?: boolean
  /** Test seam; by default the store is a sibling of the worktree directory. */
  seedRoot?: string
  /** Root from which fingerprint paths are read; defaults to the new worktree. */
  inputRoot?: string
  /** Internal runtime callers may opt in for a runtime-owned local host. */
  allowRuntimeExecutionHost?: boolean
  /** A setup without a lockfile is not reproducible and is not seeded by default. */
  allowWithoutLockfile?: boolean
  dependencies?: Partial<WorktreeDependencySeedDependencies>
}

export type WorktreeDependencySeedArgs = WorktreeDependencySeedOptions & {
  repo: WorktreeDependencySeedRepo
  worktreePath: string
  setupScript: string
  declaredSeedPaths: readonly string[]
}

export type WorktreeDependencySeedResult = {
  status: 'hydrated' | 'promoted' | 'existing' | 'miss' | 'skipped' | 'failed'
  fingerprint?: string
  paths: readonly string[]
  reason?: string
}

export type SeedContext = {
  repoPath: string
  worktreePath: string
  seedRoot: string
  seedEntryPath: string
  fingerprint: WorktreeDependencySeedFingerprint
  paths: readonly string[]
  platform: NodeJS.Platform
  dependencies: WorktreeDependencySeedDependencies
}

function repoPathOf(repo: WorktreeDependencySeedRepo): string | null {
  if (typeof repo === 'string') {
    return repo
  }
  return repo && typeof repo.path === 'string' ? repo.path : null
}

function isLocalRepo(
  repo: WorktreeDependencySeedRepo,
  allowRuntimeExecutionHost: boolean
): boolean {
  if (typeof repo === 'string') {
    return true
  }
  if (repo.connectionId) {
    return false
  }
  if (!repo.executionHostId || repo.executionHostId === 'local') {
    return true
  }
  return allowRuntimeExecutionHost && repo.executionHostId.startsWith('runtime:')
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate))
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  )
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathInside(left, right) || isPathInside(right, left)
}

/** Build a validated operation context; unsupported hosts return null. */
export async function createDependencySeedContext(
  args: WorktreeDependencySeedArgs
): Promise<SeedContext | null> {
  const platform = args.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux') {
    return null
  }
  if (
    !isLocalRepo(args.repo, args.allowRuntimeExecutionHost === true) ||
    typeof args.setupScript !== 'string' ||
    !args.setupScript.trim()
  ) {
    return null
  }
  const paths = normalizeWorktreeDependencySeedPaths(
    Array.isArray(args.declaredSeedPaths) ? args.declaredSeedPaths : []
  )
  if (paths.length === 0) {
    return null
  }
  const rawRepoPath = repoPathOf(args.repo)
  if (typeof args.worktreePath !== 'string' || !rawRepoPath) {
    return null
  }
  const repoPath = resolve(rawRepoPath)
  const worktreePath = resolve(args.worktreePath)
  const inputPaths = Array.isArray(args.fingerprintPaths)
    ? args.fingerprintPaths
    : WORKTREE_DEPENDENCY_SEED_LOCKFILE_PATHS
  const inputRoot = resolve(args.inputRoot ?? worktreePath)
  let lockfiles: DependencySeedInputFile[]
  if (args.lockfiles !== undefined) {
    if (
      !Array.isArray(args.lockfiles) ||
      args.lockfiles.some((input) => !isValidDependencySeedInput(input))
    ) {
      return null
    }
    lockfiles = [...args.lockfiles]
  } else {
    try {
      lockfiles = await readWorktreeDependencySeedInputs(inputRoot, inputPaths)
    } catch {
      // An existing but malformed/oversized input is not a reproducible seed.
      return null
    }
  }
  const fingerprint = createWorktreeDependencySeedFingerprint({
    setupScript: args.setupScript,
    lockfiles,
    platform,
    architecture: args.architecture,
    nodeMajor: args.nodeMajor,
    seedPaths: paths
  })
  if (
    LOCKFILE_REQUIRED_BY_DEFAULT &&
    fingerprint.lockfiles.length === 0 &&
    !args.allowWithoutLockfile
  ) {
    return null
  }
  const seedRoot = resolve(getWorktreeDependencySeedRoot(args.repo, worktreePath, args.seedRoot))
  // Keeping the private store outside the checkout prevents a seed entry or
  // lock directory from becoming part of the source tree it snapshots.
  if (pathsOverlap(seedRoot, worktreePath)) {
    return null
  }
  // Keep the private store out of both the new checkout and the primary repo;
  // nested worktree layouts can otherwise place generated entries under a
  // tracked checkout.
  if (pathsOverlap(seedRoot, repoPath)) {
    return null
  }
  return {
    repoPath,
    worktreePath,
    seedRoot,
    seedEntryPath: join(seedRoot, fingerprint.digest),
    fingerprint,
    paths,
    platform,
    dependencies: { ...defaultWorktreeDependencySeedDependencies, ...args.dependencies }
  }
}

export async function ensureDependencySeedRoot(context: SeedContext): Promise<void> {
  await ensureDependencySeedDirectory(context.seedRoot)
  await assertDependencySeedPathNoSymlink(context.seedRoot, context.seedRoot)
  if (!(await dependencySeedSameDevice(context.worktreePath, context.seedRoot))) {
    throw new Error('Dependency seed store is on a different volume from the worktree')
  }
}
