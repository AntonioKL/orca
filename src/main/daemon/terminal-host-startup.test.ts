import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session-subprocess-handle'

function mockSubprocess(): SubprocessHandle {
  return {
    pid: 1,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: () => {},
    onExit: () => {},
    dispose: vi.fn()
  } as SubprocessHandle
}

// Why: Windows shells (PowerShell/cmd.exe) submit on CR, not LF. Without CR
// the startup command sits typed at the prompt but unexecuted — forcing the
// user to press Enter after "claude" (or a setup script) is injected.
// POSIX shells (bash/zsh) keep the LF behaviour. A caller-supplied terminator
// must not be doubled.
describe('TerminalHost startup command terminator', () => {
  const origPlatform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform })
  })

  let sub: SubprocessHandle
  let host: TerminalHost
  beforeEach(() => {
    sub = mockSubprocess()
    host = new TerminalHost({ spawnSubprocess: () => sub })
  })

  it.each([
    ['win32', 'claude', 'claude\r'],
    ['darwin', 'claude', 'claude\n'],
    ['win32', 'claude\r', 'claude\r'],
    ['darwin', 'claude\n', 'claude\n']
  ])('submits startup with correct terminator on %s', async (platform, cmd, sent) => {
    Object.defineProperty(process, 'platform', { value: platform })
    await host.createOrAttach({
      sessionId: `s-${platform}-${cmd.length}`,
      cols: 80,
      rows: 24,
      command: cmd,
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(sub.write).toHaveBeenCalledWith(sent)
  })
})

// Why: a missing command and a lost one used to log identically.
describe('TerminalHost startup command delivery logging', () => {
  let sub: SubprocessHandle
  let events: { event: string; details: Record<string, unknown> }[]
  let host: TerminalHost

  beforeEach(() => {
    sub = mockSubprocess()
    events = []
    host = new TerminalHost({
      spawnSubprocess: () => sub,
      reportReadinessEvent: (event, details) => events.push({ event, details })
    })
  })

  const delivery = (): Record<string, unknown> =>
    events.find((e) => e.event === 'startup-command-delivery')?.details ?? {}

  it('records a written startup command', async () => {
    await host.createOrAttach({
      sessionId: 'delivery-written',
      cols: 80,
      rows: 24,
      command: 'codex',
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(delivery()).toMatchObject({ written: true, hasCommand: true, commandLength: 5 })
  })

  it('records a session created with no startup command at all', async () => {
    await host.createOrAttach({
      sessionId: 'delivery-none',
      cols: 80,
      rows: 24,
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(delivery()).toMatchObject({ written: false, hasCommand: false, commandLength: 0 })
    expect(sub.write).not.toHaveBeenCalled()
  })

  it('never logs the command text, which can carry credentials', async () => {
    await host.createOrAttach({
      sessionId: 'delivery-secret',
      cols: 80,
      rows: 24,
      command: 'deploy --token=hunter2',
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(JSON.stringify(delivery())).not.toContain('hunter2')
  })

  it('still delivers the command when the diagnostic sink throws', async () => {
    host = new TerminalHost({
      spawnSubprocess: () => sub,
      reportReadinessEvent: () => {
        throw new Error('log sink unavailable')
      }
    })

    await expect(
      host.createOrAttach({
        sessionId: 'delivery-sink-failure',
        cols: 80,
        rows: 24,
        command: 'codex',
        shellReadySupported: false,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
    ).resolves.toMatchObject({ isNew: true })
    expect(sub.write).toHaveBeenCalledWith(`codex${process.platform === 'win32' ? '\r' : '\n'}`)
  })
})

describe('TerminalHost deferred command ownership', () => {
  const command = 'codex DEFERRED_STARTUP_MARKER'
  const operationId = 'composer-reservation'
  let sub: SubprocessHandle
  let host: TerminalHost
  let spawn: ReturnType<typeof vi.fn<() => SubprocessHandle>>

  beforeEach(() => {
    sub = mockSubprocess()
    let onExit: ((code: number) => void) | undefined
    sub.onExit = (callback) => {
      onExit = callback
    }
    sub.forceKill = vi.fn(() => {
      onExit?.(0)
    })
    spawn = vi.fn(() => sub)
    host = new TerminalHost({ spawnSubprocess: spawn })
  })

  afterEach(async () => {
    await host.dispose()
  })

  async function create() {
    return host.createOrAttach({
      sessionId: 'retained-shell',
      cols: 80,
      rows: 24,
      command,
      deferredStartupOperationId: operationId,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
  }

  it('retains the original command for planning and holds all execution until release', async () => {
    const created = await create()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ command, deferStartupCommand: true })
    )
    expect(sub.write).not.toHaveBeenCalled()
    expect(host.releaseStartupCommand('retained-shell', created.incarnationId, operationId)).toBe(
      'accepted'
    )
    expect(sub.write).toHaveBeenCalledOnce()
    expect(sub.write).toHaveBeenCalledWith(
      `${command}${process.platform === 'win32' ? '\r' : '\n'}`
    )
    expect(host.releaseStartupCommand('retained-shell', created.incarnationId, operationId)).toBe(
      'accepted'
    )
    expect(sub.write).toHaveBeenCalledOnce()
  })

  it('never spawns on unknown release and rejects another operation or incarnation', async () => {
    expect(host.releaseStartupCommand('missing', 'old', operationId)).toBe('unavailable')
    expect(spawn).not.toHaveBeenCalled()
    const created = await create()
    expect(host.releaseStartupCommand('retained-shell', 'old', operationId)).toBe(
      'identity-mismatch'
    )
    expect(host.releaseStartupCommand('retained-shell', created.incarnationId, 'other')).toBe(
      'identity-mismatch'
    )
    expect(sub.write).not.toHaveBeenCalled()
  })

  it('reattaches without releasing or replacing the original pending command', async () => {
    const original = await create()
    const attached = await create()
    expect(attached.isNew).toBe(false)
    expect(attached.incarnationId).toBe(original.incarnationId)
    expect(spawn).toHaveBeenCalledOnce()
    expect(sub.write).not.toHaveBeenCalled()
    expect(host.releaseStartupCommand('retained-shell', attached.incarnationId, operationId)).toBe(
      'accepted'
    )
    expect(sub.write).toHaveBeenCalledOnce()
  })

  it('retires an unused launch after manual input into the retained shell', async () => {
    const created = await create()
    host.write('retained-shell', 'vim\r')
    expect(host.releaseStartupCommand('retained-shell', created.incarnationId, operationId)).toBe(
      'retired'
    )
    expect(sub.write).toHaveBeenCalledExactlyOnceWith('vim\r')
  })

  it('rejects an empty operation identity before spawning', async () => {
    await expect(
      host.createOrAttach({
        sessionId: 'invalid',
        cols: 80,
        rows: 24,
        command,
        deferredStartupOperationId: '',
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
    ).rejects.toThrow('Deferred startup requires')
    expect(spawn).not.toHaveBeenCalled()
  })
})
