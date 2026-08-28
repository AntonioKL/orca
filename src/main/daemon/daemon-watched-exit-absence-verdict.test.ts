/* What a daemon-backed PTY's absence proves. The runtime swaps the local provider out for a
 * daemon one (`setLocalPtyProvider` in daemon-init), so a verdict only the local provider
 * declares never reaches a shipping terminal — these cases drive the daemon route itself,
 * from the daemon's own exit event to the bytes the renderer reads. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import type { DaemonServer } from './daemon-server'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'
import { inspectPtyProviderProcessForRenderer } from '../providers/pty-process-inspection'
import { buildAbsentPtyInspection } from '../../shared/pty-process-inspection-evidence'

const itOnPosix = process.platform === 'win32' ? it.skip : it

describe('a daemon-backed watched exit', () => {
  let dir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let lastSubprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => {
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    ;({ dir, server, adapter } = harness)
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Spawns through `provider`, then lets the shell die and the real daemon report it. */
  async function watchedExitOf(provider: DaemonPtyAdapter | DaemonPtyRouter): Promise<string> {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    lastSubprocess._simulateExit(0)
    await waitFor(() => provider.hasPty(id) === false)
    return id
  }

  itOnPosix('is exited, not a route the adapter merely lost', async () => {
    const id = await watchedExitOf(adapter)

    expect(adapter.ptyAbsenceVerdict(id)).toBe('exited')
    expect(adapter.ptyAbsenceVerdict('never-spawned-here')).toBe('unverifiable')
  })

  itOnPosix('stays exited through the router that forgets its route on the exit', async () => {
    const router = new DaemonPtyRouter({ current: adapter, legacy: [] })
    const id = await watchedExitOf(router)

    expect(router.ptyAbsenceVerdict(id)).toBe('exited')
    // The routing table is empty by now, so this is the widened lookup answering — and it
    // must still refuse an id no adapter ever watched.
    expect(router.ptyAbsenceVerdict('never-routed-here')).toBe('unverifiable')
    router.dispose()
  })

  itOnPosix('does not survive into the session id that reopening the pane reuses', async () => {
    const id = await watchedExitOf(adapter)
    expect(adapter.ptyAbsenceVerdict(id)).toBe('exited')

    await adapter.spawn({ cols: 80, rows: 24, sessionId: id })

    // Why this matters: a certificate that outlived its session would answer `exited` for a
    // live pane the app merely lost the route to.
    expect(adapter.ptyAbsenceVerdict(id)).toBe('unverifiable')
  })

  itOnPosix('publishes the payload the close prompt treats as silent', async () => {
    const router = new DaemonPtyRouter({ current: adapter, legacy: [] })
    const ptyId = await watchedExitOf(router)

    // Why the shared producer and not a literal: these are the bytes the renderer reads, and
    // running-terminal-close-absence-evidence.test.ts pins `buildAbsentPtyInspection('exited')`
    // as the payload that closes a tab with no dialog and the `'unverifiable'` one — which
    // carries `unavailable` — as the payload that raises it.
    const inspection = await inspectPtyProviderProcessForRenderer(router, ptyId)
    expect(inspection).toEqual(buildAbsentPtyInspection('exited'))
    expect(inspection).not.toHaveProperty('unavailable')
    router.dispose()
  })
})
