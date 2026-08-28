import { editorSuppressedGitEnv } from '../../shared/git-sequencer-editor-env'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'

async function readSequencerMarkerOid(
  marker: string,
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '-q', '--verify', marker],
      gitOptionsForWorktree(worktreePath, options)
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

// Why: everything here predates the Git 2.25 baseline (`merge --continue` 2.12,
// REBASE_HEAD 2.17), so no capability probe or fallback is needed.
async function runSequencerAction(
  args: readonly [string, string],
  marker: string,
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<void> {
  const markerBefore = await readSequencerMarkerOid(marker, worktreePath, options)
  try {
    await runWithGitReadCacheInvalidation(() =>
      gitExecFileAsync([...args], {
        ...gitOptionsForWorktree(worktreePath, options),
        // Why: `--continue` opens the commit-message editor and would hang with no terminal to close it.
        env: editorSuppressedGitEnv()
      })
    )
  } catch (error) {
    // Why: `--continue` also exits nonzero when it DID commit the resolution and the
    // sequencer then stopped on the next commit. The operation's own marker ref moving
    // (or clearing) is the proof it advanced — unlike HEAD, no concurrent commit in the
    // worktree can touch it, so a refused step can never masquerade as progress.
    const markerAfter = await readSequencerMarkerOid(marker, worktreePath, options)
    if (!markerBefore || markerAfter === markerBefore) {
      throw error
    }
  }
}

export async function continueMerge(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runSequencerAction(['merge', '--continue'], 'MERGE_HEAD', worktreePath, options)
}

export async function continueRebase(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runSequencerAction(['rebase', '--continue'], 'REBASE_HEAD', worktreePath, options)
}

export async function continueCherryPick(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runSequencerAction(['cherry-pick', '--continue'], 'CHERRY_PICK_HEAD', worktreePath, options)
}
