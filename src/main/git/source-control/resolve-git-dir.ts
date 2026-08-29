import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { resolveGitMetadataPath } from '../git-metadata-path'

export async function resolveGitDir(
  worktreePath: string,
  options: Pick<GitRuntimeOptions, 'wslDistro'> = {}
): Promise<string | null> {
  const dotGitPath = path.join(worktreePath, '.git')

  try {
    const dotGitContents = await readFile(dotGitPath, 'utf-8')
    const firstLine = dotGitContents.split(/\r?\n/, 1)[0] ?? ''
    const match = firstLine.match(/^gitdir:\s*(.*?)\s*$/i)
    if (match) {
      return resolveGitMetadataPath(worktreePath, match[1], options)
    }
  } catch {
    // `.git` is likely a directory in a non-worktree checkout.
  }

  return dotGitPath
}
