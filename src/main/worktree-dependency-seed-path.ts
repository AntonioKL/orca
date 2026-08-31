import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

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

/**
 * macOS exposes /var (and usually /tmp) as links into /private. Those aliases
 * are part of the normal filesystem layout, not a caller-controlled seed
 * redirect, so keep them usable while rejecting every other link component.
 */
async function isAllowedSystemAlias(path: string): Promise<boolean> {
  if (process.platform !== 'darwin') {
    return false
  }
  const expectedTarget =
    path === '/var' ? '/private/var' : path === '/tmp' ? '/private/tmp' : undefined
  if (!expectedTarget) {
    return false
  }
  try {
    return (await realpath(path)) === expectedTarget
  } catch {
    return false
  }
}

/**
 * Walk every existing component of a path without following a caller-owned
 * symlink. Missing leaves are allowed because callers use this before creating
 * a target; any ancestor that already exists is still checked.
 */
async function assertPathComponentsNoSymlink(path: string): Promise<void> {
  const resolvedPath = resolve(path)
  const parsed = parse(resolvedPath)
  const segments = relative(parsed.root, resolvedPath).split(/[\\/]/u).filter(Boolean)
  let current = parsed.root
  const rootStats = await lstat(current)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw symlinkPathError(current)
  }
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    let stats
    try {
      stats = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }
    if (stats.isSymbolicLink()) {
      if (index < segments.length - 1 && (await isAllowedSystemAlias(current))) {
        const targetStats = await stat(current)
        if (!targetStats.isDirectory()) {
          throw new Error(`Dependency seed path parent is not a directory: ${current}`)
        }
        continue
      }
      throw symlinkPathError(current)
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(`Dependency seed path parent is not a directory: ${current}`)
    }
  }
}

/** Check all existing filesystem components, including ancestors of a root. */
export async function assertDependencySeedPathComponentsNoSymlink(path: string): Promise<void> {
  await assertPathComponentsNoSymlink(path)
}

/**
 * Check an existing root-relative path without following a symlink component.
 * Missing leaves are allowed so callers can distinguish a missing input from a
 * redirected one before they create or read it.
 */
export async function assertDependencySeedPathNoSymlink(
  root: string,
  candidate: string
): Promise<void> {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  if (!isPathInside(resolvedRoot, resolvedCandidate)) {
    throw new Error(`Dependency seed path escapes its root: ${candidate}`)
  }

  const rootStats = await lstat(resolvedRoot)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw symlinkPathError(resolvedRoot)
  }

  // The explicit root check above protects the boundary itself; this second
  // walk also covers symlink ancestors above that boundary (while retaining
  // the macOS /var and /tmp aliases allowed by the component helper).
  await assertPathComponentsNoSymlink(resolvedCandidate)

  const relativeCandidate = relative(resolvedRoot, resolvedCandidate)
  const segments = relativeCandidate ? relativeCandidate.split(/[\\/]/u) : []
  let current = resolvedRoot
  for (const segment of segments) {
    current = resolve(current, segment)
    let entryStats
    try {
      entryStats = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }
    if (entryStats.isSymbolicLink()) {
      throw symlinkPathError(current)
    }
  }
}

/** Create a seed directory one component at a time, rejecting redirected paths. */
export async function ensureDependencySeedDirectory(path: string): Promise<string> {
  const resolvedPath = resolve(path)
  const parsed = parse(resolvedPath)
  const segments = relative(parsed.root, resolvedPath).split(/[\\/]/u).filter(Boolean)
  let current = parsed.root

  // Walk and create one component at a time. `mkdir(..., { recursive: true })`
  // follows an existing symlink in any ancestor before we get a chance to
  // inspect it; component-wise creation lets us reject that redirect.
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    let stats
    try {
      stats = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      try {
        await mkdir(current, { mode: 0o700 })
      } catch (mkdirError) {
        // Another creator may have won the race. Re-stat below and still
        // reject a symlink rather than trusting the EEXIST outcome.
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw mkdirError
        }
      }
      stats = await lstat(current)
    }
    if (stats.isSymbolicLink()) {
      // Only system aliases may occur before the generated seed components;
      // never permit the requested target itself to be a symlink.
      if (index === segments.length - 1 || !(await isAllowedSystemAlias(current))) {
        throw symlinkPathError(current)
      }
      // Verify that an allowed alias resolves to a directory before walking
      // through it. `lstat` intentionally reports the link itself above.
      const targetStats = await stat(current)
      if (!targetStats.isDirectory()) {
        throw new Error(`Dependency seed root is not a directory: ${current}`)
      }
      continue
    }
    if (!stats.isDirectory()) {
      throw new Error(`Dependency seed root is not a directory: ${current}`)
    }
  }

  // Recheck the final entry after the walk so a replacement that happens
  // immediately after its first lstat cannot turn the returned path into a
  // symlink before callers create the lock or seed entry beneath it.
  const finalStats = await lstat(resolvedPath)
  if (finalStats.isSymbolicLink()) {
    throw symlinkPathError(resolvedPath)
  }
  if (!finalStats.isDirectory()) {
    throw new Error(`Dependency seed root is not a directory: ${resolvedPath}`)
  }
  return resolvedPath
}
