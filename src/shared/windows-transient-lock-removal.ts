// Why: Windows releases handles late. Antivirus, the search indexer, a just-exited child and a
// freshly dlopen'd DLL all keep a tree Node has just emptied locked for a few milliseconds, which
// surfaces as EBUSY/ENOTEMPTY/EPERM. Node's own `maxRetries` absorbs exactly that, and the repo
// already settled on 8 attempts — but only product code was using it, so test teardown kept
// failing tests whose assertions had already passed.

import type { RmOptions } from 'node:fs'
import { rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'

export const WINDOWS_RM_MAX_RETRIES = 8
export const WINDOWS_RM_RETRY_DELAY_MS = 150

/** `rm`/`rmSync` options for a recursive removal that must survive a late handle release. */
export function transientLockRemovalOptions(): RmOptions {
  const base = { recursive: true, force: true }
  if (process.platform !== 'win32') {
    return base
  }
  return { ...base, maxRetries: WINDOWS_RM_MAX_RETRIES, retryDelay: WINDOWS_RM_RETRY_DELAY_MS }
}

/** Recursively remove a directory, retrying the transient Windows locks. */
export function removeTreeSync(targetPath: string): void {
  rmSync(targetPath, transientLockRemovalOptions())
}

/** Recursively remove a directory, retrying the transient Windows locks. */
export async function removeTree(targetPath: string): Promise<void> {
  await rm(targetPath, transientLockRemovalOptions())
}
