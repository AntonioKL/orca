import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { inspectWorkerTerminal } from './orchestration-worker-observation'

const DISPATCH_ID = 'ctx-worker'
const TERMINAL_HANDLE = 'term-worker'

function createHarness(args: {
  connected: boolean
  hostScope: { kind: 'local'; hostId: 'local' } | { kind: 'ssh'; targetId: string }
}) {
  const runtime = {
    showTerminal: vi.fn(async () => ({ handle: TERMINAL_HANDLE, connected: args.connected })),
    getTerminalPaneKey: vi.fn(() => 'tab-worker:leaf-worker'),
    getTerminalProcessIncarnation: vi.fn(() => 'pty-worker:incarnation-1'),
    getTerminalLivenessVerdict: vi.fn(() => null),
    getOrchestrationDispatchAuthority: vi.fn(() => null)
  } as unknown as OrcaRuntimeService
  const db = {
    getWorkerDispatch: vi.fn(() => ({ agent_terminal_handle: TERMINAL_HANDLE })),
    getDispatchContextById: vi.fn(() => ({ host_scope: JSON.stringify(args.hostScope) })),
    isDispatchProcessCurrent: vi.fn(() => true)
  } as unknown as OrchestrationDb
  return { runtime, db }
}

describe('inspectWorkerTerminal missing liveness verdict', () => {
  it('keeps a connected local worker live', async () => {
    const { runtime, db } = createHarness({
      connected: true,
      hostScope: { kind: 'local', hostId: 'local' }
    })

    await expect(inspectWorkerTerminal(runtime, db, DISPATCH_ID)).resolves.toMatchObject({
      exact: true,
      status: 'live'
    })
  })

  it('keeps a disconnected local worker exited', async () => {
    const { runtime, db } = createHarness({
      connected: false,
      hostScope: { kind: 'local', hostId: 'local' }
    })

    await expect(inspectWorkerTerminal(runtime, db, DISPATCH_ID)).resolves.toMatchObject({
      exact: true,
      status: 'exited'
    })
  })

  it('keeps a remote worker without a verdict unverifiable', async () => {
    const { runtime, db } = createHarness({
      connected: false,
      hostScope: { kind: 'ssh', targetId: 'ssh-target' }
    })

    await expect(inspectWorkerTerminal(runtime, db, DISPATCH_ID)).resolves.toMatchObject({
      exact: true,
      status: 'unverifiable',
      reason: 'missing_liveness_verdict'
    })
  })
})
