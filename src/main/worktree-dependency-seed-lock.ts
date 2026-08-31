import { lstat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { lock as acquireFileLock } from 'proper-lockfile'
import { ensureDependencySeedDirectory } from './worktree-dependency-seed-path'

const lockTails = new Map<string, Promise<void>>()

// A dependency tree can take several minutes to clone on a cold disk. Keep the
// heartbeat well beyond that window so a second Orca process cannot steal a
// live lock while the first one is still materializing files.
const FILE_LOCK_STALE_MS = 30 * 60 * 1000
const FILE_LOCK_RETRIES = {
  retries: 40,
  factor: 1.2,
  minTimeout: 50,
  maxTimeout: 1000,
  randomize: true
}

async function acquireCrossProcessLock(
  lockKey: string,
  stableLockPath?: string
): Promise<(() => Promise<void>) | null> {
  // Unit callers may use symbolic keys ("same", "other"). Production seed
  // keys are absolute paths; avoid creating test lock directories in cwd.
  const lockTarget = stableLockPath ?? lockKey
  if (!isAbsolute(lockTarget)) {
    return null
  }
  // The digest entry is deliberately not the lock target: promotion renames
  // that directory. A stable seed-root directory keeps the lock in place even
  // when the entry is absent on the first call or is atomically replaced.
  const safeLockTarget = await ensureDependencySeedDirectory(lockTarget)
  // A pre-existing symlink at the lock path could redirect proper-lockfile's
  // mkdir/stat lifecycle into an unrelated directory. Reject it before the
  // package gets a chance to treat the link as a stale lock.
  try {
    const lockPathStats = await lstat(`${safeLockTarget}.lock`)
    if (lockPathStats.isSymbolicLink()) {
      throw new Error(`Refusing dependency seed lock through a symlink: ${safeLockTarget}.lock`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  return acquireFileLock(safeLockTarget, {
    // Canonicalize aliases such as /var -> /private/var so separate callers
    // cannot acquire independent locks for the same seed root.
    realpath: true,
    stale: FILE_LOCK_STALE_MS,
    update: FILE_LOCK_STALE_MS / 3,
    retries: FILE_LOCK_RETRIES
  })
}

/** Serialize seed hydration and promotion for one content-addressed entry. */
export function withWorktreeDependencySeedLock<T>(
  lockKey: string,
  operation: () => Promise<T>,
  stableLockPath?: string
): Promise<T> {
  // Resolve lexical aliases for the in-process queue as well. Symlink aliases
  // are canonicalized by proper-lockfile's realpath option above.
  const queueKey = isAbsolute(lockKey) ? resolve(lockKey) : lockKey
  const prior = lockTails.get(queueKey) ?? Promise.resolve()
  const run = prior.then(async () => {
    const release = await acquireCrossProcessLock(lockKey, stableLockPath)
    try {
      return await operation()
    } finally {
      await release?.()
    }
  })
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  lockTails.set(queueKey, tail)
  void tail.then(() => {
    if (lockTails.get(queueKey) === tail) {
      lockTails.delete(queueKey)
    }
  })
  return run
}
