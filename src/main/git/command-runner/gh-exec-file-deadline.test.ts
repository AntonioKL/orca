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

import { ghExecFileAsync } from './gh-exec-file'
import { _resetCliUnresponsiveBreaker } from '../hosted-cli-unresponsive-breaker'

function mockChild(pid = 4321): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.pid = pid
  child.kill = vi.fn(() => true)
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child as unknown as ChildProcess
}

function settleChild(child: ChildProcess, stdout: string): void {
  child.stdout?.emit('data', Buffer.from(stdout))
  child.emit('exit', 0, null)
  child.emit('close', 0, null)
}

/**
 * The contract the star check depends on after #18234: a `gh` that never exits
 * is killed at the deadline, and the kill reaches the whole chain. On the
 * reporter's box `gh` was a shell wrapper calling `mise x gh`, so signalling
 * only the direct child left the rest of the chain running under init.
 */
describe('gh exec deadline', () => {
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
  // process group died, so raw call counts mix those in with the gh spawns.
  const ghSpawnCount = (): number => spawnMock.mock.calls.filter((call) => call[0] === 'gh').length

  /** Drive one gh call all the way to its deadline kill. */
  async function runToDeadline(pid: number): Promise<void> {
    const child = mockChild(pid)
    spawnMock.mockReturnValue(child)
    const rejection = expect(
      ghExecFileAsync(['api', '--include', 'user/starred/stablyai/orca'], { timeout: 15_000 })
    ).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.advanceTimersByTimeAsync(15_000)
    await rejection
  }

  it.runIf(process.platform !== 'win32')(
    'signals the whole process group, not just the child, when gh never exits',
    async () => {
      const child = mockChild()
      // Why never emitting exit: this is exactly the stuck child from #18234 —
      // spawned, spinning, and never reporting an exit.
      spawnMock.mockReturnValue(child)

      const pending = ghExecFileAsync(['api', '--include', 'user/starred/stablyai/orca'], {
        timeout: 15_000
      })
      const rejection = expect(pending).rejects.toThrow('timed out')
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())

      // The child must be its own group leader, or the signal below would go to
      // whatever group it inherited — Orca's own.
      expect(spawnMock.mock.calls[0][2].detached).toBe(true)
      expect(processKillMock).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(15_000)
      await vi.advanceTimersByTimeAsync(15_000)
      await rejection

      expect(processKillMock).toHaveBeenCalledWith(-4321, undefined)
    }
  )

  it('spawns with hidden console and captured stdio, never an inherited or shell stdio', async () => {
    const child = mockChild()
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => settleChild(child, 'HTTP/2.0 204 No Content\r\n'))
      return child
    })

    const result = await ghExecFileAsync(['api', '--include', 'user/starred/stablyai/orca'], {
      timeout: 15_000
    })

    expect(result.stdout).toContain('204 No Content')
    const [command, args, options] = spawnMock.mock.calls[0]
    expect(command).toBe('gh')
    expect(args).toEqual(['api', '--include', 'user/starred/stablyai/orca'])
    expect(options.windowsHide).toBe(true)
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(options.shell).toBe(false)
  })

  /**
   * The half #18239 and #18258 left open. Each invocation was bounded and its
   * process group reaped, but the reporter's wrapper re-execs itself in place at
   * 100% CPU, so every caller started a fresh 15s burn ~12s after the last one
   * and the machine never got the core back. Two deadline kills is enough
   * evidence that the binary — not the network — is the problem.
   */
  it('stops spawning gh after two consecutive deadline kills', async () => {
    await runToDeadline(1)
    await runToDeadline(2)
    expect(ghSpawnCount()).toBe(2)

    await expect(
      ghExecFileAsync(['api', '--include', 'user/starred/stablyai/orca'], { timeout: 15_000 })
    ).rejects.toThrow('pausing gh')

    expect(ghSpawnCount()).toBe(2)
  })

  it('does not retry a deadline kill — each retry would pay another full deadline of spin', async () => {
    // `gh api` reads as idempotent, so the transient-retry path is live here.
    await runToDeadline(1)

    expect(ghSpawnCount()).toBe(1)
  })

  it('keeps spawning while gh still answers, even when it answers with a failure', async () => {
    const failing = mockChild(7)
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        failing.stderr?.emit('data', Buffer.from('gh: HTTP 404'))
        failing.emit('exit', 1, null)
        failing.emit('close', 1, null)
      })
      return failing
    })

    for (let i = 0; i < 3; i++) {
      await expect(
        ghExecFileAsync(['api', '--include', 'user/starred/stablyai/orca'], { timeout: 15_000 })
      ).rejects.toThrow('HTTP 404')
    }

    expect(ghSpawnCount()).toBe(3)
  })

  it('reopens after one deadline kill is followed by a healthy answer', async () => {
    await runToDeadline(1)

    const child = mockChild(2)
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => settleChild(child, 'HTTP/2.0 204 No Content\r\n'))
      return child
    })
    await ghExecFileAsync(['api', '--include', 'user/starred/stablyai/orca'], { timeout: 15_000 })

    await runToDeadline(3)
    // The healthy answer cleared the count, so this lone kill must not block.
    const after = mockChild(4)
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => settleChild(after, 'HTTP/2.0 204 No Content\r\n'))
      return after
    })
    await expect(
      ghExecFileAsync(['api', '--include', 'user/starred/stablyai/orca'], { timeout: 15_000 })
    ).resolves.toBeDefined()
  })

  it('fails rather than returning a clipped answer when gh overruns maxBuffer', async () => {
    const child = mockChild()
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => settleChild(child, '['.padEnd(64, 'x')))
      return child
    })

    await expect(
      ghExecFileAsync(['api', 'repos/stablyai/orca/issues'], { timeout: 15_000, maxBuffer: 8 })
    ).rejects.toThrow('more than 8 bytes')
  })
})
