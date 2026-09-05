import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { runProcess } from '../shared/child-process/run-process'
import { quotePosixShell } from '../shared/wsl-login-shell-command'
import { gitExecFileAsync } from './git/runner'
import {
  prepareWorktreeCreateCheckout,
  discardPreparedWorktree
} from './git/worktree-create-preparation'
import { cleanupStalePreparations } from './worktree-create-preparation-stale-cleanup'
import {
  WorktreeIndexWarmingOwnership,
  canReclaimIndexWarming
} from './worktree-index-warming-ownership'

it.skipIf(process.platform !== 'darwin')(
  'retains a dead-owner checkout while Git is live, then reclaims after group exit',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-warming-recovery-'))
    const repo = join(root, 'repo')
    const git = async (cwd: string, args: string[]) =>
      (await gitExecFileAsync(args, { cwd })).stdout.trim()
    let ownerPid = 0
    await runProcess({
      program: process.execPath,
      args: ['-e', ''],
      onChildSpawned: (pid) => {
        ownerPid = pid
      }
    })
    expect(ownerPid).toBeGreaterThan(0)
    const prepared = join(root, '.orca-preparing', `${ownerPid}-${randomUUID()}`)
    const controller = new AbortController()
    let worker: Promise<unknown> | undefined
    try {
      await git(root, ['init', '--quiet', repo])
      await git(repo, ['config', 'user.name', 'Test'])
      await git(repo, ['config', 'user.email', 'test@example.invalid'])
      await writeFile(join(repo, 'tracked'), 'content\n')
      await git(repo, ['add', 'tracked'])
      await git(repo, ['commit', '--quiet', '-m', 'initial'])
      await prepareWorktreeCreateCheckout(
        repo,
        prepared,
        'HEAD',
        `orca-create-preparation:v2:${ownerPid}:recovery-test`
      )
      const fifo = join(root, 'release'),
        ready = join(root, 'ready'),
        hook = join(root, 'fsmonitor')
      expect((await runProcess({ program: 'mkfifo', args: [fifo] })).code).toBe(0)
      await writeFile(
        hook,
        `#!/bin/sh\nprintf ready > ${quotePosixShell(ready)}\nread token < ${quotePosixShell(fifo)}\nprintf 'token\\000'\n`,
        { mode: 0o700 }
      )
      const ownership = new WorktreeIndexWarmingOwnership(prepared)
      await ownership.arm()
      worker = gitExecFileAsync(['-c', `core.fsmonitor=${hook}`, 'update-index', '--refresh'], {
        cwd: prepared,
        signal: controller.signal,
        timeout: 15_000,
        terminationBarrier: true,
        onChildSpawned: (pid) => ownership.recordPid(pid)
      }).then(
        () => ({ exited: true }),
        (error) => ({ error })
      )
      await expect
        .poll(() => readFile(ready, 'utf8').catch(() => ''), { timeout: 10_000 })
        .toBe('ready')
      await cleanupStalePreparations(repo, repo, {})
      expect(
        await stat(prepared).then(
          () => true,
          () => false
        )
      ).toBe(true)
      expect(await canReclaimIndexWarming(prepared)).toBe(false)
      await writeFile(fifo, 'release\n')
      expect(await worker).toEqual({ exited: true })
      await expect.poll(() => canReclaimIndexWarming(prepared)).toBe(true)
      await cleanupStalePreparations(repo, repo, {})
      await expect(stat(prepared)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(`${prepared}.index-warming`)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(prepared)
    } finally {
      controller.abort()
      await worker
      await discardPreparedWorktree(repo, prepared).catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000
)
