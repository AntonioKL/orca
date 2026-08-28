import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A `.tsx` file sitting next to a `.ts` of the same stem is silently dropped from
 * the program: tsconfig `include` expansion keeps one file per extensionless path
 * and `.ts` outranks `.tsx`. Nothing errors — the file just stops being typechecked,
 * which is the exact hole the typecheck-coverage work exists to close.
 *
 * Why the whole tree rather than a list of roots: a hand-kept list drifts from the
 * tsconfig `include` globs it is meant to shadow, and the gap is invisible.
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.cross-version-checkouts'
])
// TypeScript resolves these in order, so an earlier entry shadows a later one.
const EXTENSION_PRIORITY = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.d.mts', '.d.cts']

function collectFiles(root) {
  let found = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry.name)) {
      continue
    }
    const fullPath = join(root, entry.name)
    let isDirectory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      // Why guarded: a dangling symlink must not fail the sweep with a raw ENOENT.
      try {
        isDirectory = statSync(fullPath).isDirectory()
      } catch {
        continue
      }
    }
    if (isDirectory) {
      found = found.concat(collectFiles(fullPath))
      continue
    }
    if (EXTENSION_PRIORITY.some((extension) => entry.name.endsWith(extension))) {
      found.push(fullPath)
    }
  }
  return found
}

function extensionOf(path) {
  return EXTENSION_PRIORITY.filter((extension) => path.endsWith(extension)).sort(
    (left, right) => right.length - left.length
  )[0]
}

describe('typecheck extension shadowing', () => {
  it('has no file hidden from the program by a higher-priority extension', () => {
    const byStem = new Map()
    for (const file of collectFiles(repoRoot)) {
      const relativePath = relative(repoRoot, file).replaceAll('\\', '/')
      const extension = extensionOf(relativePath)
      const stem = relativePath.slice(0, -extension.length)
      byStem.set(stem, [...(byStem.get(stem) ?? []), extension])
    }

    const shadowed = [...byStem.entries()]
      .filter(([, extensions]) => extensions.length > 1)
      .map(([stem, extensions]) => {
        const ordered = EXTENSION_PRIORITY.filter((extension) => extensions.includes(extension))
        return `${stem}${ordered[1]} is shadowed by ${stem}${ordered[0]}`
      })
      .sort()

    expect(shadowed).toEqual([])
  })
})
