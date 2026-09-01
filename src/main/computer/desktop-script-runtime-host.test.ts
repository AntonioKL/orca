import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '../../shared/child-process/process-spec'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { DesktopScriptRuntimeHost, isRuntimeHostUnavailable } from './desktop-script-runtime-host'

const POLICY_ERROR =
  'File runtime.ps1 cannot be loaded because running scripts is disabled on this system.\n    + CategoryInfo : SecurityError'

class FakeRuntimeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly writes: string[] = []
  killed = false
  stdinEnded = false
  readonly stdin = {
    write: (chunk: string, callback?: (error?: Error | null) => void): boolean => {
      this.writes.push(chunk)
      callback?.(null)
      return true
    },
    end: (): void => {
      this.stdinEnded = true
    },
    on: (): void => {}
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  /** Requests written to this child, decoded. */
  requests(): Record<string, unknown>[] {
    return this.writes.map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  respond(response: unknown): void {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(response)}\n`, 'utf8'))
  }

  exit(code: number | null, stderr = ''): void {
    if (stderr) {
      this.stderr.emit('data', Buffer.from(stderr, 'utf8'))
    }
    this.emit('exit', code, null)
  }
}

function createHost(options: { idleShutdownMs?: number; requestTimeoutMs?: number } = {}) {
  const children: FakeRuntimeChild[] = []
  const specs: ProcessSpec[] = []
  const host = new DesktopScriptRuntimeHost('C:\\orca\\runtime.ps1', {
    ...options,
    powerShellPath: () => 'C:\\Windows\\System32\\powershell.exe',
    warn: () => {},
    spawn: (spec) => {
      specs.push(spec)
      const child = new FakeRuntimeChild()
      children.push(child)
      return child as unknown as ReturnType<typeof spawnProcess>
    }
  })
  return { host, children, specs }
}

/** Let the host's queue microtasks drain so the next request reaches its child. */
async function settle(): Promise<void> {
  for (let index = 0; index < 6; index++) {
    await Promise.resolve()
  }
}

describe('DesktopScriptRuntimeHost', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts one helper for many operations and never writes an operation file', async () => {
    const { host, children, specs } = createHost()

    const first = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} })
    await expect(first).resolves.toMatchObject({ ok: true })

    for (let index = 0; index < 5; index++) {
      const next = host.request({ tool: 'click', app: 'Notepad' })
      await settle()
      children[0].respond({ ok: true, action: { path: 'synthetic' } })
      await expect(next).resolves.toMatchObject({ ok: true })
    }

    expect(children).toHaveLength(1)
    expect(children[0].requests()).toHaveLength(6)
    expect(specs[0].args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'RemoteSigned',
      '-File',
      'C:\\orca\\runtime.ps1',
      '-Serve'
    ])
    host.dispose()
  })

  it('serializes requests so only one operation is ever in flight', async () => {
    const { host, children } = createHost()

    const first = host.request({ tool: 'click', app: 'A' })
    const second = host.request({ tool: 'click', app: 'B' })
    await settle()

    expect(children[0].requests()).toEqual([{ tool: 'click', app: 'A' }])

    children[0].respond({ ok: true, action: { path: 'synthetic' } })
    await expect(first).resolves.toMatchObject({ ok: true })
    await settle()

    expect(children[0].requests()).toHaveLength(2)
    children[0].respond({ ok: true, action: { path: 'accessibility' } })
    await expect(second).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('reassembles a response split across chunks, including a split code point', async () => {
    const { host, children } = createHost()
    const promise = host.request({ tool: 'get_app_state', app: 'Editor' })
    await settle()

    const payload = Buffer.from(
      `${JSON.stringify({ ok: true, snapshot: { app: 'né' } })}\n`,
      'utf8'
    )
    const split = payload.indexOf(Buffer.from('é', 'utf8')) + 1
    children[0].stdout.emit('data', payload.subarray(0, split))
    children[0].stdout.emit('data', payload.subarray(split))

    await expect(promise).resolves.toEqual({ ok: true, snapshot: { app: 'né' } })
    host.dispose()
  })

  it('times out a wedged operation and starts a fresh helper for the next one', async () => {
    vi.useFakeTimers()
    const { host, children } = createHost({ requestTimeoutMs: 30_000 })

    const promise = host.request({ tool: 'click', app: 'Frozen' })
    await settle()
    await vi.advanceTimersByTimeAsync(30_001)

    await expect(promise).rejects.toMatchObject({ code: 'action_timeout' })
    expect(children[0].killed).toBe(true)

    const next = host.request({ tool: 'handshake' })
    await settle()
    expect(children).toHaveLength(2)
    children[1].respond({ ok: true, capabilities: {} })
    await expect(next).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('rejects the in-flight request when a working helper crashes, then restarts', async () => {
    const { host, children } = createHost()

    const first = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} })
    await first

    const second = host.request({ tool: 'click', app: 'Notepad' })
    await settle()
    children[0].exit(1, 'boom')

    await expect(second).rejects.toMatchObject({ code: 'accessibility_error' })
    await expect(second).rejects.toThrow(/runtime host exited/)

    const third = host.request({ tool: 'handshake' })
    await settle()
    expect(children).toHaveLength(2)
    children[1].respond({ ok: true, capabilities: {} })
    await expect(third).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('shuts the helper down when idle and starts a new one on the next operation', async () => {
    vi.useFakeTimers()
    const { host, children } = createHost({ idleShutdownMs: 60_000 })

    const first = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} })
    await first
    await settle()

    expect(children[0].killed).toBe(false)
    await vi.advanceTimersByTimeAsync(60_001)
    expect(children[0].stdinEnded).toBe(true)
    expect(children[0].killed).toBe(true)

    const next = host.request({ tool: 'handshake' })
    await settle()
    expect(children).toHaveLength(2)
    children[1].respond({ ok: true, capabilities: {} })
    await expect(next).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('disposes the helper and rejects the in-flight request', async () => {
    const { host, children } = createHost()
    const promise = host.request({ tool: 'click', app: 'Notepad' })
    await settle()

    host.dispose()

    expect(children[0].stdinEnded).toBe(true)
    expect(children[0].killed).toBe(true)
    await expect(promise).rejects.toThrow(/shut down/)
  })

  it('falls back to Bypass once when the execution policy blocks the start', async () => {
    const { host, children, specs } = createHost()

    const promise = host.request({ tool: 'handshake' })
    await settle()
    children[0].exit(1, POLICY_ERROR)
    await settle()

    expect(children).toHaveLength(2)
    expect(specs[1].args).toContain('Bypass')
    children[1].respond({ ok: true, capabilities: {} })
    await expect(promise).resolves.toMatchObject({ ok: true })

    // The fallback is remembered for the session rather than re-probed per call.
    const next = host.request({ tool: 'handshake' })
    await settle()
    expect(children).toHaveLength(2)
    children[1].respond({ ok: true, capabilities: {} })
    await next
    host.dispose()
  })

  it('reports itself unavailable when Bypass is also refused', async () => {
    const { host, children } = createHost()

    const promise = host.request({ tool: 'handshake' })
    await settle()
    children[0].exit(1, POLICY_ERROR)
    await settle()
    children[1].exit(1, POLICY_ERROR)

    await expect(promise).rejects.toSatisfy(isRuntimeHostUnavailable)
    await expect(host.request({ tool: 'handshake' })).rejects.toSatisfy(isRuntimeHostUnavailable)
  })

  it('reports itself unavailable when the helper cannot be spawned at all', async () => {
    const host = new DesktopScriptRuntimeHost('C:\\orca\\runtime.ps1', {
      powerShellPath: () => 'C:\\Windows\\System32\\powershell.exe',
      warn: () => {},
      spawn: () => {
        throw new Error('spawn ENOENT')
      }
    })

    await expect(host.request({ tool: 'handshake' })).rejects.toSatisfy(isRuntimeHostUnavailable)
  })

  it('reports itself unavailable when a fresh helper dies before answering', async () => {
    const { host, children } = createHost()

    const promise = host.request({ tool: 'handshake' })
    await settle()
    children[0].exit(1, 'The term is not recognized')

    await expect(promise).rejects.toSatisfy(isRuntimeHostUnavailable)
  })
})
