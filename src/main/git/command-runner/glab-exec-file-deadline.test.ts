import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, processKillMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  processKillMock: vi.fn()
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: spawnMock
}))

import { glabExecFileAsync } from './glab-exec-file'
import { _resetCliUnresponsiveBreaker } from '../hosted-cli-unresponsive-breaker'

function mockChild(pid: number): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.pid = pid
  child.kill = vi.fn(() => true)
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child as unknown as ChildProcess
}

/**
 * The wrapper hazard behind #18234 is a PATH-resolution fault, not a GitHub one:
 * a `~/.local/bin/glab` that re-invokes its own name wedges exactly the way the
 * reporter's `gh` did, so glab gets the same breaker.
 */
describe('glab exec deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawnMock.mockReset()
    processKillMock.mockReset()
    vi.spyOn(process, 'kill').mockImplementation(processKillMock as unknown as typeof process.kill)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    _resetCliUnresponsiveBreaker()
  })

  // Why filtered: the POSIX termination barrier shells out to `ps` to verify the
  // process group died, so raw call counts mix those in with the glab spawns.
  const glabSpawnCount = (): number =>
    spawnMock.mock.calls.filter((call) => call[0] === 'glab').length

  async function runToDeadline(pid: number): Promise<void> {
    spawnMock.mockReturnValue(mockChild(pid))
    const rejection = expect(
      glabExecFileAsync(['api', 'projects/stablyai%2Forca/issues'], { cwd: '/repo' })
    ).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    await rejection
  }

  it('stops spawning glab after two consecutive deadline kills', async () => {
    await runToDeadline(2001)
    await runToDeadline(2002)
    expect(glabSpawnCount()).toBe(2)

    await expect(
      glabExecFileAsync(['api', 'projects/stablyai%2Forca/issues'], { cwd: '/repo' })
    ).rejects.toThrow('pausing glab')

    expect(glabSpawnCount()).toBe(2)
  })

  it('does not retry a deadline kill — each retry would pay another full deadline', async () => {
    await runToDeadline(2003)

    expect(glabSpawnCount()).toBe(1)
  })

  it('keeps spawning while glab still answers, even with a failure', async () => {
    const child = mockChild(2004)
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stderr?.emit('data', Buffer.from('glab: HTTP 404'))
        child.emit('exit', 1, null)
        child.emit('close', 1, null)
      })
      return child
    })

    for (let i = 0; i < 3; i++) {
      await expect(
        glabExecFileAsync(['api', 'projects/stablyai%2Forca/issues'], { cwd: '/repo' })
      ).rejects.toThrow('HTTP 404')
    }

    expect(glabSpawnCount()).toBe(3)
  })
})
