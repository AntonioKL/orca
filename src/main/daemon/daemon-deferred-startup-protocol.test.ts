import { afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DEFERRED_STARTUP_DAEMON_PROTOCOL_VERSION } from './daemon-protocol-version'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'

const operationId = 'composer-operation'
const command = 'codex HELD_STARTUP_MARKER'
const sessionId = 'prepared-shell'
const ready = '\x1b]777;orca-shell-ready\x07$ '

describe('deferred startup daemon control protocol', () => {
  let harness: DaemonAdapterHarness | undefined
  const clients: DaemonClient[] = []
  const adapters: DaemonPtyAdapter[] = []
  let subprocess: ReturnType<typeof createMockSubprocess>
  let spawn: ReturnType<typeof vi.fn<() => ReturnType<typeof createMockSubprocess>>>

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.disconnect()
    }
    for (const adapter of adapters.splice(0)) {
      adapter.dispose()
    }
    harness?.adapter.dispose()
    await harness?.server.shutdown()
    if (harness) {
      rmSync(harness.dir, { recursive: true, force: true })
    }
    harness = undefined
  })

  async function start(version = DEFERRED_STARTUP_DAEMON_PROTOCOL_VERSION) {
    subprocess = createMockSubprocess()
    spawn = vi.fn(() => subprocess)
    harness = await startDaemonAdapterHarness(spawn, version)
    return harness
  }

  async function prepare(adapter: DaemonPtyAdapter) {
    const result = await adapter.spawn({
      sessionId,
      isNewSession: true,
      cols: 80,
      rows: 24,
      command,
      deferredStartupOperationId: operationId
    })
    if (!result.incarnationId) {
      throw new Error('Missing terminal incarnation')
    }
    return { ...result, incarnationId: result.incarnationId }
  }

  async function rawClient() {
    if (!harness) {
      throw new Error('Missing daemon')
    }
    const client = new DaemonClient({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
    clients.push(client)
    await client.ensureConnected()
    return client
  }

  it('holds through readiness, forwards original planning, and releases one command', async () => {
    const { adapter } = await start()
    expect(adapter.supportsDeferredStartupCommands()).toBe(true)
    const result = await prepare(adapter)
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ command, deferStartupCommand: true })
    )
    subprocess._simulateData(ready)
    expect(subprocess.write).not.toHaveBeenCalled()
    expect(await adapter.releaseStartupCommand(sessionId, result.incarnationId, operationId)).toBe(
      'accepted'
    )
    await vi.waitFor(() => expect(subprocess.write).toHaveBeenCalledOnce())
    expect(subprocess.write.mock.calls[0][0]).toContain(command)
    expect(await adapter.releaseStartupCommand(sessionId, result.incarnationId, operationId)).toBe(
      'accepted'
    )
    expect(subprocess.write).toHaveBeenCalledOnce()
  })

  it('accepts release before readiness without executing early', async () => {
    const { adapter } = await start()
    const result = await prepare(adapter)
    expect(await adapter.releaseStartupCommand(sessionId, result.incarnationId, operationId)).toBe(
      'accepted'
    )
    expect(subprocess.write).not.toHaveBeenCalled()
    subprocess._simulateData(ready)
    await vi.waitFor(() => expect(subprocess.write).toHaveBeenCalledOnce())
  })

  it('rejects old-owner preparation before any spawn or release request', async () => {
    const { adapter } = await start(DEFERRED_STARTUP_DAEMON_PROTOCOL_VERSION - 1)
    expect(adapter.supportsDeferredStartupCommands()).toBe(false)
    await expect(prepare(adapter)).rejects.toThrow('does not support deferred')
    expect(await adapter.releaseStartupCommand(sessionId, 'old', operationId)).toBe('unavailable')
    expect(spawn).not.toHaveBeenCalled()
    await adapter.spawn({ sessionId: 'ordinary', cols: 80, rows: 24 })
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('never spawns from release or accepts a different incarnation or operation', async () => {
    const { adapter } = await start()
    expect(await adapter.releaseStartupCommand('absent', 'old', operationId)).toBe('unavailable')
    expect(spawn).not.toHaveBeenCalled()
    const result = await prepare(adapter)
    expect(await adapter.releaseStartupCommand(sessionId, 'old', operationId)).toBe(
      'identity-mismatch'
    )
    expect(await adapter.releaseStartupCommand(sessionId, result.incarnationId, 'other')).toBe(
      'identity-mismatch'
    )
    expect(subprocess.write).not.toHaveBeenCalled()
  })

  it('retries an unacknowledged release on a new connection without repeating execution', async () => {
    const { adapter, socketPath, tokenPath } = await start()
    const result = await prepare(adapter)
    subprocess._simulateData(ready)
    const client = await rawClient()
    expect(
      client.notify('releaseStartupCommand', {
        sessionId,
        expectedIncarnationId: result.incarnationId,
        operationId
      })
    ).toBe(true)
    await vi.waitFor(() => expect(subprocess.write).toHaveBeenCalledOnce())
    client.disconnect()
    adapter.dispose()
    const reconnected = new DaemonPtyAdapter({ socketPath, tokenPath })
    adapters.push(reconnected)
    expect(
      await reconnected.releaseStartupCommand(sessionId, result.incarnationId, operationId)
    ).toBe('accepted')
    expect(spawn).toHaveBeenCalledOnce()
    expect(subprocess.write).toHaveBeenCalledOnce()
  })

  it('retires a prepared command when the retained shell is used manually', async () => {
    const { adapter } = await start()
    const result = await prepare(adapter)
    subprocess._simulateData(ready)
    adapter.write(sessionId, 'vim\r')
    await vi.waitFor(() => expect(subprocess.write).toHaveBeenCalledOnce())
    expect(await adapter.releaseStartupCommand(sessionId, result.incarnationId, operationId)).toBe(
      'retired'
    )
    expect(subprocess.write.mock.calls[0][0]).toBe('vim\r')
  })

  it('rejects malformed release and preparation identities without spawning', async () => {
    await start()
    const client = await rawClient()
    await expect(
      client.request('releaseStartupCommand', {
        sessionId,
        expectedIncarnationId: 'id',
        operationId: 17
      })
    ).rejects.toThrow('identities')
    await expect(
      client.request('createOrAttach', {
        sessionId,
        cols: 80,
        rows: 24,
        command,
        deferredStartupOperationId: 17
      })
    ).rejects.toThrow('operation identity')
    expect(spawn).not.toHaveBeenCalled()
  })
})
