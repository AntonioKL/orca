import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WINDOWS_RM_MAX_RETRIES,
  WINDOWS_RM_RETRY_DELAY_MS,
  transientLockRemovalOptions
} from './windows-transient-lock-removal'

function withPlatform(platform: NodeJS.Platform): void {
  vi.stubGlobal('process', { ...process, platform })
}

const SOURCE_ROOT = join(__dirname, '..')
const OWNING_MODULE = join('shared', 'windows-transient-lock-removal.ts')
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'build', '.git'])
/** A `const WINDOWS_RM_… =` line, i.e. a file stating the policy rather than importing it. */
const POLICY_DECLARATION =
  /^\s*(?:export\s+)?const\s+WINDOWS_RM_(?:MAX_RETRIES|RETRY_DELAY_MS)\s*=/m

function collectSourceFiles(root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root)) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      found.push(...collectSourceFiles(path))
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path)
    }
  }
  return found
}

/** Every file that declares the retry policy instead of importing it. */
function findPolicyDeclarations(): string[] {
  return collectSourceFiles(SOURCE_ROOT)
    .filter((path) => POLICY_DECLARATION.test(readFileSync(path, 'utf8')))
    .map((path) => relative(SOURCE_ROOT, path))
    .sort()
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

  it('actually detects a file that states the policy', () => {
    // Without this the scan below passes for any reason at all, including not scanning.
    expect(POLICY_DECLARATION.test('const WINDOWS_RM_MAX_RETRIES = 8')).toBe(true)
    expect(POLICY_DECLARATION.test('  export const WINDOWS_RM_RETRY_DELAY_MS = 150')).toBe(true)
    // Importing the policy is the thing this rule is asking for, not a violation of it.
    expect(POLICY_DECLARATION.test('import { WINDOWS_RM_MAX_RETRIES } from x')).toBe(false)
    expect(POLICY_DECLARATION.test('    retryDelay: WINDOWS_RM_RETRY_DELAY_MS')).toBe(false)
  })

  it('is the only file that states the policy', () => {
    // Why a ratchet: a second copy is how "8 attempts" becomes 8 in one file and 4 in another,
    // and nothing fails until a Windows lane goes red for a reason nobody can place.
    expect(
      findPolicyDeclarations(),
      'declare the retry policy once, in src/shared/windows-transient-lock-removal.ts, and import it'
    ).toEqual([OWNING_MODULE])
  })
})
