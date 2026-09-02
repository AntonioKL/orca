import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import type { DescendantSnapshot } from '../pty-descendant-termination'
import {
  createClaudeChildTreeReaper,
  proveClaudeChildExit,
  type ClaudeChildTreeReaper
} from './claude-agent-sdk-exit-proof'

// The child traps SIGTERM; the descendant models an MCP server and either
// cooperates or, when it also traps SIGTERM, only a forced, verified sweep can reach.
function stubbornChildScript(descendantTrapsSigterm: boolean): string {
  const descendantScript = `${descendantTrapsSigterm ? 'process.on("SIGTERM", () => {}); ' : ''}setInterval(() => {}, 1000000)`
  return `
process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})
const descendant = require('node:child_process').spawn(
  process.execPath,
  ['-e', ${JSON.stringify(descendantScript)}],
  { stdio: 'ignore' }
)
descendant.unref()
process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + '\\n')
setInterval(() => {}, 1000000)
`
}

const COOPERATIVE_CHILD = `
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
process.stdout.write('ready\\n')
`

/**
 * Sampled synchronously so it reads the exact moment the close boundary is
 * crossed. A zombie has exited (its parent just has not reaped it yet), so a
 * kill(pid, 0) probe would misreport it as running.
 */
function descendantState(pid: number): 'running' | 'exited' {
  let state: string
  try {
    state = execFileSync('ps', ['-o', 'state=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' }
    }).trim()
  } catch (error) {
    // ps exits 1 when no process matches; anything else is a failed probe, not an answer.
    if ((error as { status?: number }).status !== 1) {
      throw error
    }
    return 'exited'
  }
  return state.startsWith('Z') ? 'exited' : 'running'
}

function spawnScript(script: string): ReturnType<typeof spawnProcess> {
  return spawnProcess({
    program: process.execPath,
    args: ['-e', script],
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

function firstStdoutLine(child: ReturnType<typeof spawnProcess>): Promise<string> {
  return new Promise((resolve) => {
    child.stdout.setEncoding('utf8').once('data', (chunk: string) => resolve(chunk.trim()))
  })
}

function observeExit(child: EventEmitter): { exitPromise: Promise<void>; exited: () => boolean } {
  let exited = false
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true
      resolve()
    })
  })
  return { exitPromise, exited: () => exited }
}

/** `null` models a spawn that failed before a pid existed. */
function mockChild(
  pid: number | null = 424242
): EventEmitter &
  Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin'> & { kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter()
  return Object.assign(child, {
    pid: pid ?? undefined,
    stdin: new PassThrough(),
    kill: vi.fn(() => true)
  }) as never
}

function snapshotOf(descendantPid: number): DescendantSnapshot {
  return {
    rootPgid: 1,
    descendants: [
      { pid: descendantPid, ppid: 424242, pgid: 1, startedAt: 'Mon Jan 1 00:00:00 2026' }
    ],
    capturedAtMs: 1
  }
}

describe('claude child exit proof', () => {
  it.runIf(process.platform !== 'win32')(
    'reports a proven exit only once a SIGTERM-resistant descendant is gone at the close boundary',
    async () => {
      const child = spawnScript(stubbornChildScript(true))
      const { descendantPid } = JSON.parse(await firstStdoutLine(child)) as {
        descendantPid: number
      }
      expect(descendantState(descendantPid)).toBe('running')

      try {
        const proven = await proveClaudeChildExit({ child, ...observeExit(child) })
        // Evaluated AT the boundary, not by polling until a deferred sweep timer
        // wins: true releases the lease, so a descendant still running here is
        // exactly the orphan the proof exists to prevent. False would be the
        // honest verdict for a tree that outlived the bounded ladder.
        expect({ proven, descendant: descendantState(descendantPid) }).toEqual({
          proven: true,
          descendant: 'exited'
        })
      } finally {
        // Failure-safe only: the assertion above owns the requirement, this just
        // stops a failing run from leaking a process.
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    },
    20_000
  )

  it.runIf(process.platform !== 'win32')(
    'still proves a stubborn child whose descendant honours SIGTERM',
    async () => {
      const child = spawnScript(stubbornChildScript(false))
      const { descendantPid } = JSON.parse(await firstStdoutLine(child)) as {
        descendantPid: number
      }
      try {
        const proven = await proveClaudeChildExit({ child, ...observeExit(child) })
        expect({ proven, descendant: descendantState(descendantPid) }).toEqual({
          proven: true,
          descendant: 'exited'
        })
      } finally {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    },
    20_000
  )

  it('proves a clean close without reaping when the child exits on stdin end', async () => {
    const child = spawnScript(COOPERATIVE_CHILD)
    expect(await firstStdoutLine(child)).toBe('ready')
    const reap = vi.fn(async () => false)
    const tree: ClaudeChildTreeReaper = { reap, treeExited: null }

    await expect(proveClaudeChildExit({ child, ...observeExit(child), tree })).resolves.toBe(true)
    expect(reap).not.toHaveBeenCalled()
  }, 20_000)

  it('reports an unprovable exit as false rather than assuming the child died', async () => {
    const child = mockChild()
    const reap = vi.fn(async () => true)

    await expect(
      proveClaudeChildExit({
        child,
        exitPromise: new Promise<void>(() => {}),
        exited: () => false,
        tree: { reap, treeExited: true }
      })
    ).resolves.toBe(false)
    expect(reap).toHaveBeenCalledTimes(1)
  }, 20_000)

  it('reports false when the root exit was observed but its descendants were not proven gone', async () => {
    const child = mockChild()
    const exit = observeExit(child)
    let treeExited: boolean | null = null
    const tree: ClaudeChildTreeReaper = {
      reap: vi.fn(async () => {
        child.emit('exit', null, 'SIGKILL')
        treeExited = false
        return false
      }),
      get treeExited() {
        return treeExited
      }
    }

    await expect(proveClaudeChildExit({ child, ...exit, tree })).resolves.toBe(false)
    expect(exit.exited()).toBe(true)
  }, 20_000)

  it('re-verifies an unproven tree on a retried close instead of trusting the dead root', async () => {
    const child = mockChild()
    let treeExited: boolean | null = false
    const reap = vi.fn(async () => {
      treeExited = true
      return true
    })
    const tree: ClaudeChildTreeReaper = {
      reap,
      get treeExited() {
        return treeExited
      }
    }

    await expect(
      proveClaudeChildExit({ child, exitPromise: Promise.resolve(), exited: () => true, tree })
    ).resolves.toBe(true)
    expect(reap).toHaveBeenCalledTimes(1)
  })
})

describe('claude child tree reaper', () => {
  it('kills the root while verification runs and never stops it first', async () => {
    const child = mockChild()
    const release = Promise.withResolvers<boolean>()
    const terminateDescendants = vi.fn(() => release.promise)
    const captureDescendants = vi.fn(async () => snapshotOf(4243))
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'darwin',
      captureDescendants,
      terminateDescendants
    })

    const first = tree.reap()
    const second = tree.reap()
    await vi.waitFor(() => expect(terminateDescendants).toHaveBeenCalledTimes(1))
    // A stopped root cannot verify: its killed children stay zombie rows in ps.
    expect(child.kill.mock.calls).toEqual([['SIGKILL']])
    expect(tree.treeExited).toBeNull()

    release.resolve(true)
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(captureDescendants).toHaveBeenCalledTimes(1)
    expect(tree.treeExited).toBe(true)
  })

  it('re-verifies the retained snapshot on a later reap rather than re-walking a dead root', async () => {
    const child = mockChild()
    const captureDescendants = vi.fn(async () => snapshotOf(4243))
    const terminateDescendants = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants,
      terminateDescendants
    })

    await expect(tree.reap()).resolves.toBe(false)
    expect(tree.treeExited).toBe(false)
    await expect(tree.reap()).resolves.toBe(true)
    expect(captureDescendants).toHaveBeenCalledTimes(1)
    expect(terminateDescendants).toHaveBeenNthCalledWith(2, snapshotOf(4243))
    expect(tree.treeExited).toBe(true)
  })

  it('treats an unreadable process table as unproven, and stays unproven on retry', async () => {
    const child = mockChild()
    const captureDescendants = vi.fn(async () => null)
    const terminateDescendants = vi.fn()
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      captureDescendants,
      terminateDescendants
    })

    await expect(tree.reap()).resolves.toBe(false)
    await expect(tree.reap()).resolves.toBe(false)
    expect(child.kill.mock.calls).toEqual([['SIGKILL'], ['SIGKILL']])
    expect(captureDescendants).toHaveBeenCalledTimes(1)
    expect(terminateDescendants).not.toHaveBeenCalled()
  })

  it('waits for the Windows tree kill before releasing the root', async () => {
    const child = mockChild()
    const release = Promise.withResolvers<void>()
    const terminateWindowsTree = vi.fn(() => release.promise)
    const captureDescendants = vi.fn()
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      captureDescendants,
      terminateWindowsTree
    })

    const reap = tree.reap()
    await vi.waitFor(() => expect(terminateWindowsTree).toHaveBeenCalledWith(424242))
    expect(child.kill).not.toHaveBeenCalled()
    release.resolve()
    await expect(reap).resolves.toBe(true)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(captureDescendants).not.toHaveBeenCalled()
  })

  it('has nothing to reap for a child that never spawned', async () => {
    const child = mockChild(null)
    const captureDescendants = vi.fn()
    const tree = createClaudeChildTreeReaper(child, { platform: 'linux', captureDescendants })

    await expect(tree.reap()).resolves.toBe(true)
    expect(captureDescendants).not.toHaveBeenCalled()
  })
})
