import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  execFileMock,
  spawnMock,
  killSpawnedCommandTreeMock,
  signalProcessTreeMock,
  forceTerminateProcessTreeMock
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
  killSpawnedCommandTreeMock: vi.fn().mockResolvedValue(undefined),
  signalProcessTreeMock: vi.fn().mockResolvedValue(false),
  forceTerminateProcessTreeMock: vi.fn().mockResolvedValue(false)
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  execFile: execFileMock,
  spawn: spawnMock
}))
vi.mock('./spawned-command-tree-kill', () => ({
  killSpawnedCommandTree: killSpawnedCommandTreeMock
}))
vi.mock('../../../shared/child-process/process-tree-termination', () => ({
  signalProcessTree: signalProcessTreeMock,
  forceTerminateProcessTree: forceTerminateProcessTreeMock
}))

import { gitExecFileAsync, gitExecFileAsyncBuffer } from './git-exec-file'
import { execFileCapture } from './exec-file-capture'
import {
  GitAdmissionScheduler,
  _gitAdmissionSnapshotForTests,
  _resetGitAdmissionForTests
} from './git-subprocess-admission'

type ExecCallback = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void

function mockChild(pid: number | undefined = 1234): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.pid = pid
  child.kill = vi.fn(() => true)
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child as unknown as ChildProcess
}

describe('git exec admission lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    execFileMock.mockReset()
    spawnMock.mockReset()
    killSpawnedCommandTreeMock.mockClear()
    _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 1 }))
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetGitAdmissionForTests()
  })

  it('retains the string-exec permit after timeout settlement until close', async () => {
    const child = mockChild()
    execFileMock.mockReturnValue(child)
    const pending = gitExecFileAsync(['status'], { cwd: '/repo', timeout: 10 })
    const rejection = expect(pending).rejects.toThrow('timed out')
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledOnce())

    await vi.advanceTimersByTimeAsync(10)
    await rejection
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)

    child.emit('close', null, 'SIGKILL')
    await Promise.resolve()
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
  })

  it('retains the buffer-exec permit after maxBuffer settlement until close', async () => {
    const child = mockChild()
    let callback: ExecCallback | undefined
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, received: ExecCallback) => {
        callback = received
        return child
      }
    )
    const pending = gitExecFileAsyncBuffer(['show', 'HEAD:file'], { cwd: '/repo' })
    await vi.waitFor(() => expect(callback).toBeTypeOf('function'))

    callback?.(new Error('maxBuffer exceeded'), Buffer.alloc(0), Buffer.alloc(0))
    await expect(pending).rejects.toThrow('maxBuffer exceeded')
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)

    child.emit('close', null, 'SIGTERM')
    await Promise.resolve()
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
  })

  it('reports pre-aborted capture as a no-child termination', async () => {
    const controller = new AbortController()
    const onChildTerminated = vi.fn()
    controller.abort()

    await expect(
      execFileCapture('git', ['status'], {
        signal: controller.signal,
        onChildTerminated
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(execFileMock).not.toHaveBeenCalled()
    expect(onChildTerminated).toHaveBeenCalledOnce()
  })

  it('releases termination-barrier admission on confirmed close', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const pending = gitExecFileAsync(['status'], {
      cwd: '/repo',
      terminationBarrier: true
    })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)

    child.emit('close', 0, null)
    await expect(pending).resolves.toEqual({ stdout: '', stderr: '' })
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
  })

  it('releases barrier admission at bounded unverifiable-exit settlement', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const pending = gitExecFileAsync(['status'], {
      cwd: '/repo',
      terminationBarrier: true,
      timeout: 10
    })
    const rejection = expect(pending).rejects.toThrow('timed out')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())

    await vi.advanceTimersByTimeAsync(2010)
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    await rejection
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
  })
})
