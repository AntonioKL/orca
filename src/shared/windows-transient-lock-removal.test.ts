import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WINDOWS_RM_MAX_RETRIES,
  WINDOWS_RM_RETRY_DELAY_MS,
  transientLockRemovalOptions
} from './windows-transient-lock-removal'

function withPlatform(platform: NodeJS.Platform): void {
  vi.stubGlobal('process', { ...process, platform })
}

describe('transient lock removal options', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries on Windows, where a late handle release is the whole problem', () => {
    withPlatform('win32')

    expect(transientLockRemovalOptions()).toEqual({
      recursive: true,
      force: true,
      maxRetries: WINDOWS_RM_MAX_RETRIES,
      retryDelay: WINDOWS_RM_RETRY_DELAY_MS
    })
  })

  it('matches the repo policy of eight attempts', () => {
    // Same number src/main/host-tree-removal.ts and codex-accounts/service.ts already use.
    expect(WINDOWS_RM_MAX_RETRIES).toBe(8)
  })

  it('asks for no retries where removal is not raced by the OS', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      withPlatform(platform)
      expect(transientLockRemovalOptions()).toEqual({ recursive: true, force: true })
      vi.unstubAllGlobals()
    }
  })
})
