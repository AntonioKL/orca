import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '../../shared/child-process/process-spec'
import type { RuntimeChildProcess } from './desktop-script-serve-channel'
import { DesktopScriptRuntimeHost, isRuntimeHostUnavailable } from './desktop-script-runtime-host'

const POLICY_ERROR =
  'File runtime.ps1 cannot be loaded because running scripts\nis disabled on this system.\n    + CategoryInfo : SecurityError'

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

  /** The id the host is currently waiting on, so replies can echo it. */
  pendingId(): number {
    return this.requests().at(-1)?.requestId as number
  }

  respond(response: Record<string, unknown>, requestId = this.pendingId()): void {
    this.write(`${JSON.stringify({ ...response, requestId })}\n`)
  }

  write(raw: string): void {
    this.stdout.emit('data', Buffer.from(raw, 'utf8'))
  }

  exit(code: number | null, stderr = ''): void {
    if (stderr) {
      this.stderr.emit('data', Buffer.from(stderr, 'utf8'))
    }
    this.emit('close', code, null)
  }
}

function createHost(
  options: {
    idleShutdownMs?: number
    requestTimeoutMs?: number
    cooldownMs?: number
    now?: () => number
  } = {}
) {
  const children: FakeRuntimeChild[] = []
  const specs: ProcessSpec[] = []
  const warnings: string[] = []
  const host = new DesktopScriptRuntimeHost('C:\\orca\\runtime.ps1', {
    ...options,
    powerShellPath: () => 'C:\\Windows\\System32\\powershell.exe',
    warn: (message) => warnings.push(message),
    spawn: (spec) => {
      specs.push(spec)
      const child = new FakeRuntimeChild()
      children.push(child)
      return child as unknown as RuntimeChildProcess
    }
  })
  return { host, children, specs, warnings }
}

/** Let the host's queue microtasks drain so the next request reaches its child. */
async function settle(): Promise<void> {
  for (let index = 0; index < 6; index++) {
    await Promise.resolve()
  }
}

/** Kill each helper the host starts, until it stops starting them. */
async function failEveryStart(children: FakeRuntimeChild[], stderr: string): Promise<void> {
  for (let index = 0; index < 8; index++) {
    if (index >= children.length) {
      return
    }
    children[index].exit(1, stderr)
    await settle()
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
      '-NoLogo',
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

    expect(children[0].requests()).toEqual([{ tool: 'click', app: 'A', requestId: 1 }])

    children[0].respond({ ok: true, action: { path: 'synthetic' } })
    await expect(first).resolves.toMatchObject({ ok: true })
    await settle()

    expect(children[0].requests()).toHaveLength(2)
    children[0].respond({ ok: true, action: { path: 'accessibility' } })
    await expect(second).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('strips the echoed id from the response it hands back', async () => {
    const { host, children } = createHost()
    const promise = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} })

    await expect(promise).resolves.toEqual({ ok: true, capabilities: {} })
    host.dispose()
  })

  it('reassembles a response split across chunks, including a split code point', async () => {
    const { host, children } = createHost()
    const promise = host.request({ tool: 'get_app_state', app: 'Editor' })
    await settle()

    const payload = Buffer.from(
      `${JSON.stringify({ ok: true, snapshot: { app: 'né' }, requestId: 1 })}\r\n`,
      'utf8'
    )
    const split = payload.indexOf(Buffer.from('é', 'utf8')) + 1
    children[0].stdout.emit('data', payload.subarray(0, split))
    children[0].stdout.emit('data', payload.subarray(split))

    await expect(promise).resolves.toEqual({ ok: true, snapshot: { app: 'né' } })
    host.dispose()
  })

  it('kills the helper rather than answering a request with another reply', async () => {
    const { host, children } = createHost()

    const first = host.request({ tool: 'handshake' })
    await settle()
    // A stray line would otherwise shift every later response by one.
    children[0].respond({ ok: true, capabilities: {} }, 999)

    await expect(first).rejects.toThrow(/did not match the pending request/)
    expect(children[0].killed).toBe(true)
    host.dispose()
  })

  it('kills the helper when an unsolicited line arrives with nothing pending', async () => {
    const { host, children } = createHost()

    const first = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} })
    await first

    children[0].write(`${JSON.stringify({ ok: true, requestId: 77 })}\n`)
    expect(children[0].killed).toBe(true)
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

  it('stops respawning a helper that dies on every second operation', async () => {
    let clock = 1_000
    const { host, children } = createHost({ cooldownMs: 60_000, now: () => clock })

    // One good answer per helper is exactly the pattern that used to respawn
    // forever: the success reset the failure count before it could ever trip.
    for (let round = 0; round < 3; round++) {
      const good = host.request({ tool: 'handshake' })
      await settle()
      children.at(-1)?.respond({ ok: true, capabilities: {} })
      await expect(good).resolves.toMatchObject({ ok: true })
      await settle()

      const crash = host.request({ tool: 'click', app: 'Crashy' })
      await settle()
      children.at(-1)?.exit(1, 'boom')
      await expect(crash).rejects.toThrow(/runtime host exited/)
      await settle()
    }

    const spawned = children.length
    await expect(host.request({ tool: 'handshake' })).rejects.toSatisfy(isRuntimeHostUnavailable)
    expect(children).toHaveLength(spawned)
    host.dispose()
  })

  it('keeps serving a healthy helper after an isolated crash', async () => {
    const { host, children } = createHost({ cooldownMs: 60_000 })

    const crashed = host.request({ tool: 'handshake' })
    await settle()
    children[0].respond({ ok: true, capabilities: {} })
    await crashed
    const second = host.request({ tool: 'click', app: 'Notepad' })
    await settle()
    children[0].exit(1, 'boom')
    await expect(second).rejects.toThrow(/runtime host exited/)

    for (let index = 0; index < 4; index++) {
      const next = host.request({ tool: 'handshake' })
      await settle()
      children.at(-1)?.respond({ ok: true, capabilities: {} })
      await expect(next).resolves.toMatchObject({ ok: true })
    }

    // A clean run clears the count, so one bad helper cannot degrade a good one.
    expect(children).toHaveLength(2)
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

  it('never respawns for a request queued behind dispose', async () => {
    const { host, children } = createHost()
    const first = host.request({ tool: 'handshake' })
    const queued = host.request({ tool: 'handshake' })
    await settle()

    host.dispose()
    await expect(first).rejects.toBeInstanceOf(Error)
    await expect(queued).rejects.toSatisfy(isRuntimeHostUnavailable)
    await settle()

    expect(children).toHaveLength(1)
  })

  it('falls back to Bypass once when the execution policy blocks the start', async () => {
    const { host, children, specs, warnings } = createHost()

    const promise = host.request({ tool: 'handshake' })
    await settle()
    children[0].exit(1, POLICY_ERROR)
    await settle()

    expect(children).toHaveLength(2)
    expect(specs[1].args).toContain('Bypass')
    children[1].respond({ ok: true, capabilities: {} })
    await expect(promise).resolves.toMatchObject({ ok: true })
    expect(warnings.some((line) => /Bypass for the rest of this session/.test(line))).toBe(true)

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
    await failEveryStart(children, POLICY_ERROR)

    await expect(promise).rejects.toSatisfy(isRuntimeHostUnavailable)
    host.dispose()
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
    host.dispose()
  })

  it('retries a transient pre-answer death without the caller ever seeing it', async () => {
    const { host, children } = createHost()

    const promise = host.request({ tool: 'handshake' })
    await settle()
    children[0].exit(1, 'Add-Type : Cannot access the temporary directory')
    await settle()

    expect(children).toHaveLength(2)
    children[1].respond({ ok: true, capabilities: {} })

    await expect(promise).resolves.toMatchObject({ ok: true })
    host.dispose()
  })

  it('gives up only after repeated start failures, then serves from the host again after the cooldown', async () => {
    let clock = 1_000
    const { host, children, warnings } = createHost({ cooldownMs: 60_000, now: () => clock })

    const failed = host.request({ tool: 'handshake' })
    await settle()
    await failEveryStart(children, 'The term is not recognized')
    await expect(failed).rejects.toSatisfy(isRuntimeHostUnavailable)

    const attempts = children.length
    expect(attempts).toBe(3)

    // Inside the cooldown the host stays out of the way without respawning.
    clock += 30_000
    await expect(host.request({ tool: 'handshake' })).rejects.toSatisfy(isRuntimeHostUnavailable)
    expect(children).toHaveLength(attempts)

    // Past it, the next operation re-probes rather than staying degraded forever.
    clock += 31_000
    const recovered = host.request({ tool: 'handshake' })
    await settle()
    expect(children).toHaveLength(attempts + 1)
    children[attempts].respond({ ok: true, capabilities: {} })
    await expect(recovered).resolves.toMatchObject({ ok: true })

    expect(warnings.at(-1)).toMatch(/recovered/)
    host.dispose()
  })
})
