import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import { proveClaudeChildExit } from './claude-agent-sdk-exit-proof'

const STUBBORN_CHILD = `
process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})
const descendant = require('node:child_process').spawn(
  process.execPath,
  ['-e', 'setInterval(() => {}, 1000000)'],
  { stdio: 'ignore' }
)
descendant.unref()
process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + '\\n')
setInterval(() => {}, 1000000)
`

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Signals are delivered asynchronously, so death is polled rather than sampled once. */
async function until(settled: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!settled() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return settled()
}

describe('claude child exit proof', () => {
  it.runIf(process.platform !== 'win32')(
    'bounded-tree-kills a stubborn child with a descendant and reports only an observed exit',
    async () => {
      const child = spawnProcess({
        program: process.execPath,
        args: ['-e', STUBBORN_CHILD],
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const descendantPid = await new Promise<number>((resolve) => {
        child.stdout.setEncoding('utf8').once('data', (chunk: string) => {
          resolve((JSON.parse(chunk.trim()) as { descendantPid: number }).descendantPid)
        })
      })
      expect(alive(descendantPid)).toBe(true)

      let exited = false
      const exitPromise = new Promise<void>((resolve) => {
        child.once('exit', () => {
          exited = true
          resolve()
        })
      })

      try {
        await expect(
          proveClaudeChildExit({ child, exitPromise, exited: () => exited })
        ).resolves.toBe(true)
        // True is only ever returned after the exit event actually fired: the child
        // traps SIGTERM, so this only settles once the forced ladder step lands.
        expect(exited).toBe(true)
        // The descendant is signalled from a snapshot taken while its parent link
        // still exists. Killing the parent first would reparent it out of reach.
        await expect(until(() => !alive(descendantPid))).resolves.toBe(true)
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

  it('reports an unprovable exit as false rather than assuming the child died', async () => {
    const child = new EventEmitter() as EventEmitter &
      Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin'>
    Object.assign(child, { pid: 424242, stdin: new PassThrough(), kill: vi.fn(() => true) })
    const killTree = vi.fn()

    await expect(
      proveClaudeChildExit({
        child,
        exitPromise: new Promise<void>(() => {}),
        exited: () => false,
        killTree
      })
    ).resolves.toBe(false)
    expect(killTree).toHaveBeenCalledTimes(1)
  }, 20_000)
})
