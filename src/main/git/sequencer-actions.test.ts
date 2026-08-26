import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitRunnerModuleMock } from './status-test-harness'

const { gitExecFileAsyncMock, gitExecFileAsyncBufferMock, gitStreamOptionsMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileAsyncBufferMock: vi.fn(),
    gitStreamOptionsMock: vi.fn()
  })
)

vi.mock('./runner', () =>
  createGitRunnerModuleMock({
    gitExecFileAsyncMock,
    gitExecFileAsyncBufferMock,
    gitStreamOptionsMock
  })
)

import { continueCherryPick, continueMerge, continueRebase } from './sequencer-actions'

type SequencerAction = (worktreePath: string, options?: { wslDistro?: string }) => Promise<void>

const CASES: readonly [string, SequencerAction, string[]][] = [
  ['continueMerge', continueMerge, ['merge', '--continue']],
  ['continueRebase', continueRebase, ['rebase', '--continue']],
  ['continueCherryPick', continueCherryPick, ['cherry-pick', '--continue']]
]

// The HEAD probe runs before the sequencer step, so calls are matched by argv, not index.
function optionsFor(args: readonly string[]): { env?: NodeJS.ProcessEnv } | undefined {
  const call = gitExecFileAsyncMock.mock.calls.find(
    (called: unknown[]) => (called[0] as string[]).join(' ') === args.join(' ')
  )
  return call?.[1] as { env?: NodeJS.ProcessEnv } | undefined
}

function headProbe(oid: string) {
  return (args: readonly string[]) =>
    args[0] === 'rev-parse'
      ? Promise.resolve({ stdout: `${oid}\n`, stderr: '' })
      : Promise.resolve({ stdout: '', stderr: '' })
}

describe('git sequencer actions', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockImplementation(headProbe('abc123'))
  })

  it.each(CASES)('%s runs the matching git command in the worktree', async (_name, run, args) => {
    await run('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      args,
      expect.objectContaining({ cwd: '/repo' })
    )
  })

  // Regression guard: without GIT_EDITOR the `--continue` child waits forever on the commit editor.
  it.each(CASES)('%s suppresses the commit-message editor', async (_name, run, args) => {
    await run('/repo')

    expect(optionsFor(args)?.env?.GIT_EDITOR).toBe('true')
  })

  it('forwards runtime options such as the WSL distro', async () => {
    await continueRebase('/repo', { wslDistro: 'Ubuntu' })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rebase', '--continue'],
      expect.objectContaining({ cwd: '/repo', wslDistro: 'Ubuntu' })
    )
  })

  // `git rebase --continue` exits nonzero when it lands the resolution and then stops on the
  // NEXT commit's conflict. HEAD moved, so that is the sequencer advancing, not a failed step.
  it('treats a stop on the next commit as progress once HEAD has moved', async () => {
    let head = 'aaa111'
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: `${head}\n`, stderr: '' })
      }
      head = 'bbb222'
      return Promise.reject(new Error('error: could not apply ec9b3362... feat: add thing'))
    })

    await expect(continueRebase('/repo')).resolves.toBeUndefined()
  })

  it('still fails a step that refused to run, leaving HEAD where it was', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) =>
      args[0] === 'rev-parse'
        ? Promise.resolve({ stdout: 'aaa111\n', stderr: '' })
        : Promise.reject(new Error('f.txt: needs merge'))
    )

    await expect(continueRebase('/repo')).rejects.toThrow('needs merge')
  })

  // An unborn HEAD (or an unreadable one) proves nothing, so the original failure stands.
  it('rethrows when HEAD cannot be read', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) =>
      args[0] === 'rev-parse'
        ? Promise.reject(new Error('fatal: bad revision'))
        : Promise.reject(new Error('cherry-pick failed'))
    )

    await expect(continueCherryPick('/repo')).rejects.toThrow('cherry-pick failed')
  })
})
