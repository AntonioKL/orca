import { editorSuppressedGitEnv } from '../../shared/git-sequencer-editor-env'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'

async function readHeadOid(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--verify', 'HEAD'],
      gitOptionsForWorktree(worktreePath, options)
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

// Why: every subcommand here predates the Git 2.25 baseline (`merge --continue` 2.12,
// the rest older), so no capability probe or fallback is needed.
async function runSequencerAction(
  args: readonly [string, string],
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<void> {
  const headBefore = await readHeadOid(worktreePath, options)
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
    // sequencer then stopped on the next commit. A moved HEAD is the proof it advanced;
    // only an unmoved one means the step refused and nothing happened.
    const headAfter = await readHeadOid(worktreePath, options)
    if (!headBefore || !headAfter || headAfter === headBefore) {
      throw error
    }
  }
}

export async function continueMerge(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runSequencerAction(['merge', '--continue'], worktreePath, options)
}

export async function continueRebase(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runSequencerAction(['rebase', '--continue'], worktreePath, options)
}

export async function continueCherryPick(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runSequencerAction(['cherry-pick', '--continue'], worktreePath, options)
}
