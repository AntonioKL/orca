import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import {
  canForkDaemonThroughUtilityProcess,
  forkDaemonThroughUtilityProcess,
  setDaemonUtilityProcessFork,
  type UtilityProcessForkFn,
  type UtilityProcessLike
} from './daemon-utility-process-fork'
import type { DaemonShimDownMessage, UtilityDaemonForkSpec } from './daemon-utility-fork-messages'

class FakeShim extends EventEmitter implements UtilityProcessLike {
  pid = 999
  posted: DaemonShimDownMessage[] = []
  killed = false
  postMessage(message: unknown): void {
    this.posted.push(message as DaemonShimDownMessage)
  }
  kill(): boolean {
    this.killed = true
    return true
  }
}

const SPEC: UtilityDaemonForkSpec = {
  entryPath: '/fake/daemon-entry.js',
  args: ['--socket', '/fake/sock'],
  cwd: '/fake/userData',
  env: { ELECTRON_RUN_AS_NODE: '1' },
  execPath: '/fake/electron'
}

let shim: FakeShim
let forkedPaths: string[]

const forkFn: UtilityProcessForkFn = (modulePath) => {
  forkedPaths.push(modulePath)
  return shim
}

/** Runs the handshake to a resolved child: shim-ready -> spawn -> spawned. */
async function forkSettledChild() {
  const promise = forkDaemonThroughUtilityProcess(SPEC, forkFn)
  shim.emit('message', { kind: 'shim-ready' })
  shim.emit('message', { kind: 'spawned', pid: 777 })
  return await promise
}

beforeEach(() => {
  shim = new FakeShim()
  forkedPaths = []
  setAppEnvironment({
    getAppPath: () => '/fake/app',
    getPath: () => '/fake/userData',
    getVersion: () => '1.2.3',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  } as unknown as AppEnvironment)
})

afterEach(() => {
  vi.useRealTimers()
  setDaemonUtilityProcessFork(null)
})

describe('canForkDaemonThroughUtilityProcess', () => {
  it('never uses the utility hop on macOS: posix_spawn already strips descriptors and TCC needs the direct fork', () => {
    setDaemonUtilityProcessFork(forkFn)
    expect(canForkDaemonThroughUtilityProcess('darwin')).toBe(false)
  })

  it('uses the utility hop on Linux and Windows once the desktop installs the port', () => {
    setDaemonUtilityProcessFork(forkFn)
    expect(canForkDaemonThroughUtilityProcess('linux')).toBe(true)
    expect(canForkDaemonThroughUtilityProcess('win32')).toBe(true)
  })

  it('declines on hosts that install no port (plain-node serve)', () => {
    expect(canForkDaemonThroughUtilityProcess('linux')).toBe(false)
    expect(canForkDaemonThroughUtilityProcess('win32')).toBe(false)
  })
})

describe('forkDaemonThroughUtilityProcess', () => {
  it('forks the shim entry and hands it the spawn spec over postMessage, never argv', async () => {
    const child = await forkSettledChild()
    expect(forkedPaths[0]).toContain('daemon-utility-launcher-shim.js')
    expect(shim.posted).toEqual([{ kind: 'spawn', spec: SPEC }])
    expect(child.pid).toBe(777)
    expect(child.connected).toBe(true)
  })

  it('relays daemon IPC messages, stderr, and exit through the ChildProcess surface', async () => {
    const child = await forkSettledChild()
    const messages: unknown[] = []
    const stderrChunks: string[] = []
    const exits: [number | null, NodeJS.Signals | null][] = []
    child.on('message', (message) => messages.push(message))
    child.stderr?.on('data', (chunk) => stderrChunks.push(chunk.toString('utf8')))
    child.on('exit', (code, signal) => exits.push([code, signal]))

    shim.emit('message', { kind: 'daemon-message', message: { type: 'ready' } })
    shim.emit('message', { kind: 'daemon-stderr', text: 'boom trace' })
    shim.emit('message', { kind: 'daemon-exit', code: 1, signal: null })

    expect(messages).toEqual([{ type: 'ready' }])
    expect(stderrChunks).toEqual(['boom trace'])
    expect(exits).toEqual([[1, null]])
    expect(child.exitCode).toBe(1)
    // Nothing left to relay once the daemon is gone.
    expect(shim.killed).toBe(true)
  })

  it('rejects when the shim reports a spawn failure', async () => {
    const promise = forkDaemonThroughUtilityProcess(SPEC, forkFn)
    shim.emit('message', { kind: 'shim-ready' })
    shim.emit('message', { kind: 'spawn-error', message: 'ENOENT' })
    await expect(promise).rejects.toThrow('ENOENT')
    expect(shim.killed).toBe(true)
  })

  it('rejects when the shim dies during the handshake', async () => {
    const promise = forkDaemonThroughUtilityProcess(SPEC, forkFn)
    shim.emit('message', { kind: 'shim-ready' })
    shim.emit('exit', 1)
    await expect(promise).rejects.toThrow('exited during the launch handshake')
  })

  it('rejects when the shim never answers', async () => {
    vi.useFakeTimers()
    const promise = forkDaemonThroughUtilityProcess(SPEC, forkFn)
    const assertion = expect(promise).rejects.toThrow('handshake timed out')
    await vi.advanceTimersByTimeAsync(10_001)
    await assertion
    expect(shim.killed).toBe(true)
  })

  it('surfaces an unexpected shim death after launch as a child error', async () => {
    const child = await forkSettledChild()
    const errors: Error[] = []
    child.on('error', (error) => errors.push(error))
    shim.emit('exit', 1)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('before the daemon settled')
  })

  it('suppresses late daemon-error relays after release: no listener remains to catch them', async () => {
    const child = await forkSettledChild()
    child.disconnect()
    // Would be an uncaught exception if emitted with no 'error' listener.
    expect(() =>
      shim.emit('message', { kind: 'daemon-error', message: 'late failure' })
    ).not.toThrow()
  })

  it('disconnect releases the shim instead of killing the daemon', async () => {
    const child = await forkSettledChild()
    const errors: Error[] = []
    child.on('error', (error) => errors.push(error))
    child.disconnect()
    expect(child.connected).toBe(false)
    expect(shim.posted).toContainEqual({ kind: 'release' })
    // The shim exiting after release is the expected shutdown, not a failure.
    shim.emit('exit', 0)
    expect(errors).toEqual([])
  })
})
