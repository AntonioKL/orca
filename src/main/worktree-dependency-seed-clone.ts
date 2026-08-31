import { randomUUID as nodeRandomUUID } from 'node:crypto'
import { link, mkdir, rm, rmdir, stat, lstat, readdir, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { cloneWorktreePathWithApfs, type ApfsCloneDeps } from './ipc/worktree-apfs-clone'
import {
  runProcess,
  type ProcessResult,
  type ProcessSpec
} from '../shared/child-process/run-process'
import { assertDependencySeedPathComponentsNoSymlink } from './worktree-dependency-seed-path'

export type DependencySeedProcessRunner = (
  spec: ProcessSpec
) => Promise<Pick<ProcessResult, 'code' | 'signal' | 'stderr'>>

export type WorktreeDependencySeedDependencies = {
  runProcess: DependencySeedProcessRunner
  randomUUID: () => string
  cloneDarwinPath: (
    source: string,
    target: string,
    sourceIsDirectory: boolean,
    deps?: ApfsCloneDeps
  ) => Promise<void>
}

export const defaultWorktreeDependencySeedDependencies: WorktreeDependencySeedDependencies = {
  runProcess,
  randomUUID: nodeRandomUUID,
  cloneDarwinPath: cloneWorktreePathWithApfs
}

function isAlreadyExists(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'EEXIST'
}

export async function dependencySeedPathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export async function dependencySeedSameDevice(
  source: string,
  targetDirectory: string
): Promise<boolean> {
  const [sourceStats, targetStats] = await Promise.all([stat(source), stat(targetDirectory)])
  return sourceStats.dev === targetStats.dev
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate))
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  )
}

function symlinkPathError(path: string): Error {
  return new Error(`Refusing dependency seed path through a symlink: ${path}`)
}

/** Reject dependency-tree links that would escape (or point back to) a checkout. */
export async function assertDependencySeedTreeNoExternalSymlinks(root: string): Promise<void> {
  const resolvedRoot = resolve(root)
  const canonicalRoot = await realpath(resolvedRoot)
  const pending = [resolvedRoot]
  while (pending.length > 0) {
    const current = pending.pop()!
    const stats = await lstat(current)
    if (stats.isSymbolicLink()) {
      const target = await readlink(current)
      // Absolute links would retain a checkout/host-specific target after a
      // clone. Windows drive links need the same treatment on POSIX hosts.
      if (isAbsolute(target) || /^[a-zA-Z]:[\\/]/u.test(target)) {
        throw symlinkPathError(current)
      }
      try {
        const canonicalTarget = await realpath(resolve(dirname(current), target))
        if (!isPathInside(canonicalRoot, canonicalTarget)) {
          throw symlinkPathError(current)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw symlinkPathError(current)
        }
        throw error
      }
      continue
    }
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new Error(`Refusing unsupported dependency seed entry: ${current}`)
    }
    if (!stats.isDirectory()) {
      continue
    }
    const entries = await readdir(current)
    for (const entry of entries) {
      pending.push(join(current, entry))
    }
  }
}

/**
 * Validate an existing source path without following any symlink component.
 * The source root is explicit so a caller cannot accidentally seed outside the
 * checkout (or hydrate from outside the private seed entry).
 */
async function assertContainedSource(root: string, source: string): Promise<void> {
  const resolvedRoot = resolve(root)
  const resolvedSource = resolve(source)
  await assertDependencySeedPathComponentsNoSymlink(resolvedSource)
  if (!isPathInside(resolvedRoot, resolvedSource)) {
    throw new Error(`Dependency seed source escapes its root: ${source}`)
  }

  const rootStats = await lstat(resolvedRoot)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw symlinkPathError(resolvedRoot)
  }

  const relativeSource = relative(resolvedRoot, resolvedSource)
  const segments = relativeSource ? relativeSource.split(/[\\/]/u) : []
  let current = resolvedRoot
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    const entryStats = await lstat(current)
    if (entryStats.isSymbolicLink()) {
      throw symlinkPathError(source)
    }
    if (index < segments.length - 1 && !entryStats.isDirectory()) {
      throw new Error(`Dependency seed source parent is not a directory: ${source}`)
    }
  }
  await assertDependencySeedTreeNoExternalSymlinks(resolvedSource)
}

/**
 * Create a target's missing parent directories one component at a time. A
 * recursive mkdir follows a pre-existing symlink; checking each component
 * after creation keeps a malicious or stale checkout from redirecting a copy.
 */
async function ensureContainedTargetDirectory(root: string, directory: string): Promise<void> {
  const resolvedRoot = resolve(root)
  const resolvedDirectory = resolve(directory)
  await assertDependencySeedPathComponentsNoSymlink(resolvedDirectory)
  if (!isPathInside(resolvedRoot, resolvedDirectory)) {
    throw new Error(`Dependency seed target escapes its root: ${directory}`)
  }

  const rootStats = await lstat(resolvedRoot)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw symlinkPathError(resolvedRoot)
  }

  const relativeDirectory = relative(resolvedRoot, resolvedDirectory)
  const segments = relativeDirectory ? relativeDirectory.split(/[\\/]/u) : []
  let current = resolvedRoot
  for (const segment of segments) {
    current = join(current, segment)
    let entryStats
    try {
      entryStats = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      try {
        await mkdir(current)
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw mkdirError
        }
      }
      entryStats = await lstat(current)
    }
    if (entryStats.isSymbolicLink()) {
      throw symlinkPathError(directory)
    }
    if (!entryStats.isDirectory()) {
      throw new Error(`Dependency seed target parent is not a directory: ${directory}`)
    }
  }
}

async function runLinuxReflink(
  source: string,
  target: string,
  sourceIsDirectory: boolean,
  dependencies: WorktreeDependencySeedDependencies
): Promise<void> {
  // `always` is important: cp must fail on filesystems without reflinks rather
  // than silently turning a seed into a multi-gigabyte regular copy.
  const args = sourceIsDirectory
    ? ['--reflink=always', '--no-clobber', '-a', '--', `${source}${sep}.`, target]
    : ['--reflink=always', '--', source, target]
  const result = await dependencies.runProcess({
    program: '/bin/cp',
    args,
    stdio: ['ignore', 'pipe', 'pipe'],
    // A cold dependency tree can exceed the generic 30-second subprocess
    // bound; the surrounding seed lock already serializes this long operation.
    timeoutMs: null
  })
  if (result.code !== 0 || result.signal) {
    const detail = result.stderr.trim()
    throw new Error(
      `Copy-on-write clone unavailable for dependency seed${detail ? `: ${detail}` : ''}`
    )
  }
}

async function cloneFileWithLinuxReflink(
  source: string,
  target: string,
  dependencies: WorktreeDependencySeedDependencies
): Promise<'cloned' | 'exists'> {
  const temporaryTarget = `${target}.orca-seed-${dependencies.randomUUID()}`
  try {
    await runLinuxReflink(source, temporaryTarget, false, dependencies)
    try {
      await link(temporaryTarget, target)
      return 'cloned'
    } catch (error) {
      if (isAlreadyExists(error)) {
        return 'exists'
      }
      throw error
    }
  } finally {
    await rm(temporaryTarget, { force: true }).catch(() => {})
  }
}

async function cloneDirectoryWithLinuxReflink(
  source: string,
  target: string,
  dependencies: WorktreeDependencySeedDependencies
): Promise<'cloned' | 'exists'> {
  try {
    // Reserve the destination first: a concurrent setup cannot be replaced by
    // cp after the existence preflight.
    await mkdir(target)
  } catch (error) {
    if (isAlreadyExists(error)) {
      return 'exists'
    }
    throw error
  }
  try {
    await runLinuxReflink(source, target, true, dependencies)
    return 'cloned'
  } catch (error) {
    // Remove only an empty reservation. A partial clone remains inspectable and
    // is never mistaken for a complete seed by the marker check.
    await rmdir(target).catch(() => {})
    throw error
  }
}

/** Clone one dependency path without replacing a path that already exists. */
export async function cloneDependencySeedPath(
  source: string,
  target: string,
  platform: NodeJS.Platform,
  dependencies: WorktreeDependencySeedDependencies = defaultWorktreeDependencySeedDependencies,
  targetRoot = dirname(target),
  sourceRoot = dirname(source)
): Promise<'cloned' | 'exists'> {
  await assertContainedSource(sourceRoot, source)
  const sourceStats = await stat(source)
  await ensureContainedTargetDirectory(targetRoot, dirname(target))
  if (await dependencySeedPathExists(target)) {
    return 'exists'
  }
  if (!(await dependencySeedSameDevice(source, dirname(target)))) {
    throw new Error('Copy-on-write dependency seed requires source and target on one volume')
  }
  // Recheck both sides after the asynchronous probes. This closes the common
  // race where a checkout component is replaced with a symlink while we probe
  // device identity, before handing paths to cp/clonefile.
  await assertContainedSource(sourceRoot, source)
  await ensureContainedTargetDirectory(targetRoot, dirname(target))
  if (platform === 'darwin') {
    await dependencies.cloneDarwinPath(source, target, sourceStats.isDirectory())
    return 'cloned'
  }
  if (platform === 'linux') {
    return sourceStats.isDirectory()
      ? cloneDirectoryWithLinuxReflink(source, target, dependencies)
      : cloneFileWithLinuxReflink(source, target, dependencies)
  }
  throw new Error(`Copy-on-write dependency seeds are unsupported on ${platform}`)
}

/** Remove a generated seed entry, treating a missing entry as success. */
export async function removeDependencySeedEntry(path: string): Promise<void> {
  try {
    const entryStats = await lstat(path)
    await rm(path, { recursive: !entryStats.isSymbolicLink(), force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}
