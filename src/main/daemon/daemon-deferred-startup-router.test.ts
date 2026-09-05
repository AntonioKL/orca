import { afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DEFERRED_STARTUP_DAEMON_PROTOCOL_VERSION } from './daemon-protocol-version'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'

const version = DEFERRED_STARTUP_DAEMON_PROTOCOL_VERSION
const command = 'codex'
const operationId = 'composer'

describe('deferred startup across preserved daemon owners', () => {
  const harnesses: DaemonAdapterHarness[] = []
  const routers: DaemonPtyRouter[] = []

  afterEach(async () => {
    for (const router of routers.splice(0)) {
      router.dispose()
    }
    for (const harness of harnesses.splice(0)) {
      harness.adapter.dispose()
      await harness.server.shutdown()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  })

  async function owner(protocolVersion = version) {
    const subprocess = createMockSubprocess()
    const spawn = vi.fn(() => subprocess)
    const harness = await startDaemonAdapterHarness(spawn, protocolVersion)
    harnesses.push(harness)
    return { ...harness, spawn, subprocess }
  }

  function router(current: DaemonAdapterHarness, legacy: DaemonAdapterHarness) {
    const result = new DaemonPtyRouter({ current: current.adapter, legacy: [legacy.adapter] })
    routers.push(result)
    return result
  }

  it('prepares on the current owner even when an old daemon is preserved', async () => {
    const current = await owner()
    const legacy = await owner(version - 1)
    const provider = router(current, legacy)
    expect(provider.supportsDeferredStartupCommands()).toBe(true)
    const prepared = await provider.spawn({
      cols: 80,
      rows: 24,
      command,
      deferredStartupOperationId: operationId
    })
    expect(prepared.incarnationId).toBeTruthy()
    expect(current.spawn).toHaveBeenCalledOnce()
    expect(legacy.spawn).not.toHaveBeenCalled()
    current.subprocess._simulateData('\x1b]777;orca-shell-ready\x07$ ')
    expect(current.subprocess.write).not.toHaveBeenCalled()
    expect(
      await provider.releaseStartupCommand(prepared.id, prepared.incarnationId!, operationId)
    ).toBe('accepted')
    await vi.waitFor(() => expect(current.subprocess.write).toHaveBeenCalledOnce())
  })

  it('rediscovers the exact retained owner without requiring fresh-spawn support', async () => {
    const current = await owner(version - 1)
    const retained = await owner()
    const prepared = await retained.adapter.spawn({
      cols: 80,
      rows: 24,
      command,
      deferredStartupOperationId: operationId
    })
    const provider = router(current, retained)
    expect(provider.supportsDeferredStartupCommands()).toBe(false)
    retained.subprocess._simulateData('\x1b]777;orca-shell-ready\x07$ ')
    expect(
      await provider.releaseStartupCommand(prepared.id, prepared.incarnationId!, operationId)
    ).toBe('accepted')
    await vi.waitFor(() => expect(retained.subprocess.write).toHaveBeenCalledOnce())
    expect(
      await provider.releaseStartupCommand(prepared.id, prepared.incarnationId!, operationId)
    ).toBe('accepted')
    expect(retained.subprocess.write).toHaveBeenCalledOnce()
    expect(current.spawn).not.toHaveBeenCalled()
  })

  it('never falls back to a new owner for an absent or mismatched retained session', async () => {
    const current = await owner()
    const retained = await owner()
    const prepared = await retained.adapter.spawn({
      cols: 80,
      rows: 24,
      command,
      deferredStartupOperationId: operationId
    })
    const provider = router(current, retained)
    expect(await provider.releaseStartupCommand('absent', 'old', operationId)).toBe('unavailable')
    expect(
      await provider.releaseStartupCommand(prepared.id, 'wrong-incarnation', operationId)
    ).toBe('identity-mismatch')
    const unknownRoute = router(current, retained)
    expect(
      await unknownRoute.releaseStartupCommand(prepared.id, 'wrong-incarnation', operationId)
    ).toBe('unverifiable')
    expect(current.spawn).not.toHaveBeenCalled()
    expect(retained.subprocess.write).not.toHaveBeenCalled()
  })
})
