import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A `.tsx` file sitting next to a `.ts` of the same stem is silently dropped from
 * the program: tsconfig `include` expansion keeps one file per extensionless path
 * and `.ts` outranks `.tsx`. Nothing errors — the file just stops being typechecked,
 * which is the exact hole the typecheck-coverage work exists to close.
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const SCANNED_ROOTS = ['src', 'tests', 'config', 'mobile/src', 'mobile/app']
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '.cross-version-checkouts'
])
// TypeScript resolves these in order, so an earlier entry shadows a later one.
const EXTENSION_PRIORITY = ['.ts', '.tsx', '.d.ts']

function collectFiles(root) {
  let found = []
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const fullPath = join(root, entry)
    if (statSync(fullPath).isDirectory()) {
      found = found.concat(collectFiles(fullPath))
      continue
    }
    if (EXTENSION_PRIORITY.some((extension) => entry.endsWith(extension))) {
      found.push(fullPath)
    }
  }
  return found
}

function extensionOf(path) {
  return path.endsWith('.d.ts') ? '.d.ts' : path.endsWith('.tsx') ? '.tsx' : '.ts'
}

function stemOf(path) {
  return path.slice(0, -extensionOf(path).length)
}

describe('typecheck extension shadowing', () => {
  it('has no file hidden from the program by a higher-priority extension', () => {
    const byStem = new Map()
    for (const root of SCANNED_ROOTS) {
      for (const file of collectFiles(join(repoRoot, root))) {
        const stem = stemOf(relative(repoRoot, file).replaceAll('\\', '/'))
        byStem.set(stem, [...(byStem.get(stem) ?? []), extensionOf(file)])
      }
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
