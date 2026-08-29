/* What a daemon-backed PTY's absence proves. The runtime swaps the local provider out for a
 * daemon one (`setLocalPtyProvider` in daemon-init), so a verdict only the local provider
 * declares never reaches a shipping terminal — these cases drive the daemon route itself,
 * from the daemon's own exit event to the bytes the renderer reads. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { IPtyProvider } from '../providers/types'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import type { DaemonServer } from './daemon-server'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'
import { inspectPtyProviderProcessForRenderer } from '../providers/pty-process-inspection'
import { buildAbsentPtyInspection } from '../../shared/pty-process-inspection-evidence'

const itOnPosix = process.platform === 'win32' ? it.skip : it

/** Degraded mode always carries a local fallback; this one owns nothing, so every answer
 *  in these cases comes from the daemon route under test. */
function neverOwningFallback(): IPtyProvider {
  return {
    hasPty: () => false,
    onData: () => () => {},
    onExit: () => () => {},
    onReplay: () => () => {}
  } as unknown as IPtyProvider
}

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

  itOnPosix('is exited when only a preserved legacy generation watched it die', async () => {
    // The only shape that builds a router at all: daemon-init wraps in one when
    // `legacyAdapters.length > 0`, and that preserved generation still owns the panes it
    // spawned before the upgrade — the current adapter has never seen this session id.
    const replacement = await startDaemonAdapterHarness(() => createMockSubprocess())
    const router = new DaemonPtyRouter({ current: replacement.adapter, legacy: [adapter] })
    try {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      await router.discoverLegacySessions()
      expect(router.hasPty(id)).toBe(true)

      lastSubprocess._simulateExit(0)
      await waitFor(() => router.hasPty(id) === false)

      // Both narrower lookups are dead here: the exit fan-out has already dropped the route,
      // and the current adapter never watched this id. Only the legacy adapter holds proof.
      expect(replacement.adapter.ptyAbsenceVerdict(id)).toBe('unverifiable')

      const inspection = await inspectPtyProviderProcessForRenderer(router, id)
      expect(inspection).toEqual(buildAbsentPtyInspection('exited'))
      expect(inspection).not.toHaveProperty('unavailable')
    } finally {
      router.disposeRouterOnly()
      replacement.adapter.dispose()
      await replacement.server.shutdown()
      rmSync(replacement.dir, { recursive: true, force: true })
    }
  })

  itOnPosix('does not let a legacy generation certify the id its replacement reuses', async () => {
    // Two real daemons, as in an upgrade: the legacy one watches the exit, and reopening the
    // pane reuses that session id on the current one. `markSessionActive` clears only the
    // certificate its own adapter issued, so the legacy one keeps its — and the router's
    // verdict asks every adapter.
    const replacement = await startDaemonAdapterHarness(() => createMockSubprocess())
    const router = new DaemonPtyRouter({ current: replacement.adapter, legacy: [adapter] })
    try {
      const id = await watchedExitOf(adapter)
      expect(adapter.ptyAbsenceVerdict(id)).toBe('exited')

      await router.spawn({ cols: 80, rows: 24, sessionId: id })
      expect(router.hasPty(id)).toBe(true)

      // The replacement's daemon goes away without reporting an exit: tracking drops, no
      // certificate is issued for it, and the session's fate is simply unknown.
      replacement.adapter.fanoutSyntheticExits(1)
      expect(router.hasPty(id)).toBe(false)

      // The bytes the renderer reads: `unavailable` is what raises the running-process
      // dialog, and a previous generation's certificate must not be able to strip it.
      const inspection = await inspectPtyProviderProcessForRenderer(router, id)
      expect(inspection).toEqual(buildAbsentPtyInspection('unverifiable'))
      expect(inspection).toHaveProperty('unavailable')
    } finally {
      router.disposeRouterOnly()
      replacement.adapter.dispose()
      await replacement.server.shutdown()
      rmSync(replacement.dir, { recursive: true, force: true })
    }
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

describe('a degraded-mode exit that beats its own spawn reply', () => {
  let dir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter

  beforeEach(async () => {
    // The daemon writes the startup command after attaching the stream client and before
    // returning the create reply, so exiting from `write` lands the exit event in that gap.
    const harness = await startDaemonAdapterHarness(() => {
      const subprocess = createMockSubprocess()
      subprocess.write.mockImplementation(() => subprocess._simulateExit(0))
      return subprocess
    })
    ;({ dir, server, adapter } = harness)
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  itOnPosix('keeps the certificate that the withheld route left as the only record', async () => {
    const provider = new DegradedDaemonPtyProvider({
      current: adapter,
      legacy: [],
      fallback: neverOwningFallback(),
      probeCurrentDaemonSpawn: async () => true
    })
    try {
      await provider.recoverFreshSpawnRouting()
      const result = await provider.spawn({
        cols: 80,
        rows: 24,
        command: 'exit',
        env: { SHELL: '/bin/sh' }
      })

      // The precondition, from the real daemon: it watched the process go, and because the
      // reply says so the spawn deliberately records no route. The certificate is all there is.
      expect(result.exitedBeforeSpawnReply).toBe(true)
      expect(provider.hasPty(result.id)).toBe(false)

      // The bytes the renderer reads: `unavailable` is what raises the running-process dialog
      // and holds completion monitoring open, so a watched exit must not carry it.
      const inspection = await inspectPtyProviderProcessForRenderer(provider, result.id)
      expect(inspection).toEqual(buildAbsentPtyInspection('exited'))
      expect(inspection).not.toHaveProperty('unavailable')
    } finally {
      provider.disposeProviderOnly()
    }
  })
})
