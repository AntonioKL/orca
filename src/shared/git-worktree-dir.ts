import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { parseWslUncPath, toWindowsWslPath } from './wsl-paths'

/**
 * Resolve a worktree's private git dir: `.git` itself, or the target of a linked
 * worktree's `gitdir:` pointer file. Pure fs (no git subprocess), so it is host
 * Git-version agnostic. Single resolver for the main and relay callers so their
 * on-disk state probes (conflict/rebase detection) cannot drift.
 */
export async function resolveWorktreeGitDir(worktreePath: string): Promise<string> {
  const dotGitPath = path.join(worktreePath, '.git')
  try {
    const contents = await readFile(dotGitPath, 'utf-8')
    const match = contents.match(/^gitdir:\s*(.+)\s*$/m)
    if (match) {
      // Why: a WSL checkout's pointer holds a Linux path; resolving it against the UNC
      // checkout would land on the local Windows drive. Map it through the checkout's distro.
      const wsl = parseWslUncPath(worktreePath)
      if (wsl && match[1].startsWith('/')) {
        return toWindowsWslPath(match[1], wsl.distro)
      }
      return path.resolve(worktreePath, match[1])
    }
  } catch {
    // `.git` is a directory in a primary checkout.
  }
  return dotGitPath
}
