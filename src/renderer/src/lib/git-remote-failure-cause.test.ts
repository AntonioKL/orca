import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { normalizeGitErrorMessage } from '../../../shared/git-remote-error'
import { resolveRemoteOperationErrorMessage } from './source-control-remote-error'

const execFileAsync = promisify(execFile)

/**
 * Real `git push`/`git fetch` failures, not stubs: a fake GIT_SSH_COMMAND makes the
 * transport fail the way a missing key does, so git itself writes the two-part stderr
 * (cause first, generic "and the repository exists." advice last) this suite is about.
 * No network — the fake ssh never connects.
 */
async function runFailingGitRemoteOperation(subcommand: 'push' | 'fetch'): Promise<Error> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-git-remote-failure-'))
  const ssh = join(dir, 'fake-ssh.sh')
  writeFileSync(
    ssh,
    '#!/bin/sh\necho "git@github.com: Permission denied (publickey)." >&2\nexit 255\n'
  )
  chmodSync(ssh, 0o755)
  const git = (args: string[]): Promise<unknown> => execFileAsync('git', args, { cwd: dir })
  await git(['init', '-q'])
  await git(['config', 'user.email', 'test@example.com'])
  await git(['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'a.txt'), 'hi\n')
  await git(['add', 'a.txt'])
  await git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'])
  await git(['remote', 'add', 'origin', 'git@github.com:acme/repo.git'])
  const args =
    subcommand === 'push' ? ['push', '--set-upstream', 'origin', 'HEAD'] : ['fetch', '--prune']
  try {
    await execFileAsync('git', args, {
      cwd: dir,
      env: { ...process.env, GIT_SSH_COMMAND: ssh, GIT_TERMINAL_PROMPT: '0' }
    })
  } catch (error) {
    return error as Error
  }
  throw new Error(`git ${subcommand} unexpectedly succeeded`)
}

/** Electron rewraps every rejected `ipcMain.handle` before the renderer reads it. */
function asRendererSeesIt(channel: string, message: string): Error {
  return new Error(`Error invoking remote method '${channel}': Error: ${message}`)
}

const CAUSE = 'Permission denied (publickey)'
const GENERIC_TAIL = 'and the repository exists.'

describe('a failing git remote operation keeps its cause', () => {
  let pushFailure: Error
  let fetchFailure: Error

  beforeAll(async () => {
    ;[pushFailure, fetchFailure] = await Promise.all([
      runFailingGitRemoteOperation('push'),
      runFailingGitRemoteOperation('fetch')
    ])
  }, 60_000)

  it('git really did print the cause first and the generic advice last', () => {
    const stderr = (pushFailure as Error & { stderr?: string }).stderr ?? ''
    expect(stderr).toContain(CAUSE)
    expect(stderr.trimEnd().endsWith(GENERIC_TAIL)).toBe(true)
  })

  it.each([
    ['push', 'git:push', { isPush: true }],
    ['fetch', 'git:fetch', { isFetch: true }],
    ['pull', 'git:pull', undefined]
  ] as const)('surfaces the cause to the %s toast', (operation, channel, options) => {
    const failure = operation === 'fetch' ? fetchFailure : pushFailure
    const produced = normalizeGitErrorMessage(failure, operation)

    // The producer must not decide which half of git's output the user needs.
    expect(produced).toContain(CAUSE)

    const toast = resolveRemoteOperationErrorMessage(asRendererSeesIt(channel, produced), options)
    expect(toast).toContain(CAUSE)
    expect(toast).not.toContain('Error invoking remote method')
  })

  it('reads as one sentence when git’s own line already ends in a period', () => {
    const toast = resolveRemoteOperationErrorMessage(
      asRendererSeesIt('git:push', normalizeGitErrorMessage(pushFailure, 'push')),
      { isPush: true }
    )
    expect(toast).toContain(`${CAUSE}. Check your remote access`)
    expect(toast).not.toContain('..')
  })

  it('does not leave the user reading only git’s closing advice', () => {
    const toast = resolveRemoteOperationErrorMessage(
      asRendererSeesIt('git:push', normalizeGitErrorMessage(pushFailure, 'push')),
      { isPush: true }
    )
    expect(toast).not.toBe(`Push failed. ${GENERIC_TAIL} Check your remote access and try again.`)
    expect(toast).not.toBe('Push failed. Check your connection and try again.')
  })
})
