import { describe, expect, it, vi } from 'vitest'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import { terminateDescendantSnapshotWithVerdict } from '../pty-descendant-exit-verification'
import {
  collectDescendantRows,
  type DescendantSnapshot,
  type ProcessTableRow
} from '../pty-descendant-termination'
import { createClaudeChildTreeReaper, proveClaudeChildExit } from './claude-agent-sdk-exit-proof'

const ROOT_PID = 500
const ORCA_PGID = 400
const ROOT_STARTED_AT = 'Thu Sep 3 16:37:20 2026'
const BIRTH_SECOND = 'Thu Sep 3 16:37:40 2026'
const BIRTH_MS = Date.parse(BIRTH_SECOND)
/** The measured shape: ten MCP-like children forked inside second :40. */
const DESCENDANT_PIDS = [600, 601, 602, 603, 604, 605, 606, 607, 608, 609]

function tableRows(descendantStartedAt: string): ProcessTableRow[] {
  return [
    { pid: ROOT_PID, ppid: 1, pgid: ORCA_PGID, startedAt: ROOT_STARTED_AT },
    ...DESCENDANT_PIDS.map((pid) => ({
      pid,
      ppid: ROOT_PID,
      pgid: ORCA_PGID,
      startedAt: descendantStartedAt
    }))
  ]
}

/** A real ppid walk from the root, exactly as production captures one. */
function walk(capturedAtMs: number, descendantStartedAt = BIRTH_SECOND): DescendantSnapshot {
  return collectDescendantRows(ROOT_PID, tableRows(descendantStartedAt), capturedAtMs)
}

/**
 * Drives the real verifier against a process table where every descendant traps
 * SIGTERM, so only a forced sweep can end them.
 */
function sigtermResistantVerifier(sendSignal: (pid: number, signal: NodeJS.Signals) => void) {
  return (snapshot: DescendantSnapshot) =>
    terminateDescendantSnapshotWithVerdict(snapshot, {
      requireIdentityBeforeSignal: true,
      graceMs: 0,
      verifyMs: 120,
      sendSignal,
      readTable: async () => ({ rows: tableRows(BIRTH_SECOND), capturedAtMs: Date.now() })
    })
}

function killedPids(calls: [number, NodeJS.Signals][]): number[] {
  return calls.flatMap(([pid, signal]) => (signal === 'SIGKILL' ? [pid] : []))
}

function signalledPids(calls: [number, NodeJS.Signals][]): number[] {
  return calls.flatMap(([pid, signal]) => (signal === 'SIGTERM' ? [pid] : []))
}

async function sweep(captures: DescendantSnapshot[]): Promise<[number, NodeJS.Signals][]> {
  const calls: [number, NodeJS.Signals][] = []
  const captureDescendants = vi.fn()
  for (const capture of captures) {
    captureDescendants.mockResolvedValueOnce(capture)
  }
  const tree = createClaudeChildTreeReaper(
    { pid: ROOT_PID, kill: vi.fn(() => true) },
    {
      platform: 'linux',
      exited: () => false,
      captureDescendants,
      terminateDescendants: sigtermResistantVerifier((pid, signal) => calls.push([pid, signal]))
    }
  )
  // The close ladder's shape: arm, then re-walk the live root at the boundary.
  await tree.capture()
  await tree.refresh?.()
  await tree.reap()
  return calls
}

describe('Claude descendant forced-sweep boundary', () => {
  it('escalates descendants first seen in their own birth second', async () => {
    // Arm lands inside second :40, the same second the children were forked in;
    // the close-boundary walk re-derives them from the live root in second :41.
    const calls = await sweep([walk(BIRTH_MS + 231), walk(BIRTH_MS + 1_200)])

    expect(signalledPids(calls)).toEqual(DESCENDANT_PIDS)
    expect(killedPids(calls)).toEqual(DESCENDANT_PIDS)
  })

  it('still escalates descendants born before the capture that first saw them', async () => {
    const earlier = 'Thu Sep 3 16:37:17 2026'
    const calls: [number, NodeJS.Signals][] = []
    const tree = createClaudeChildTreeReaper(
      { pid: ROOT_PID, kill: vi.fn(() => true) },
      {
        platform: 'linux',
        exited: () => false,
        captureDescendants: vi.fn(async () =>
          collectDescendantRows(ROOT_PID, tableRows(earlier), BIRTH_MS + 231)
        ),
        terminateDescendants: (snapshot) =>
          terminateDescendantSnapshotWithVerdict(snapshot, {
            requireIdentityBeforeSignal: true,
            graceMs: 0,
            verifyMs: 120,
            sendSignal: (pid, signal) => calls.push([pid, signal]),
            readTable: async () => ({ rows: tableRows(earlier), capturedAtMs: Date.now() })
          })
      }
    )

    await tree.capture()
    await tree.reap()

    expect(killedPids(calls)).toEqual(DESCENDANT_PIDS)
  })

  it('withholds the sweep while no walk has re-proved the rows in a later second', async () => {
    // Both walks land inside the birth second: nothing has disambiguated the
    // rows, so the forced sweep must still stand down.
    const calls = await sweep([walk(BIRTH_MS + 231), walk(BIRTH_MS + 640)])

    expect(signalledPids(calls)).toEqual(DESCENDANT_PIDS)
    expect(killedPids(calls)).toEqual([])
  })
})

describe('Claude close-boundary re-walk', () => {
  it('re-walks the live root before stdin closes, not only after the grace window', async () => {
    // The measured teardown: the root leaves on its own inside the grace window,
    // so the post-timeout refresh never runs and this is the last walk that can
    // happen while the root is still there to be walked from.
    const order: string[] = []
    const tree = {
      capture: vi.fn(async () => {
        order.push('capture')
      }),
      refresh: vi.fn(async () => {
        order.push('refresh')
      }),
      reap: vi.fn(async (): Promise<DescendantTreeVerdict> => {
        order.push('reap')
        return 'exited'
      }),
      get treeVerdict(): DescendantTreeVerdict {
        return 'unverifiable'
      }
    }
    const stdin = { end: vi.fn(() => order.push('stdin-end')) }

    await proveClaudeChildExit({
      child: { pid: ROOT_PID, kill: vi.fn(() => true), stdin } as never,
      exitPromise: Promise.resolve(),
      exited: () => true,
      tree
    })

    expect(order).toEqual(['capture', 'refresh', 'stdin-end', 'reap'])
  })
})
