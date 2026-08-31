/* Log-cap rotation must preserve durable scrollback depth (#17114): the refused
 * batch is carried into the next full checkpoint's durable rebuild instead of
 * forcing the short live window over deep on-disk history. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { getHistorySessionDirName } from './history-paths'
import type { HistoryManager } from './history-manager'
import type { PendingOutputRecord, TerminalSnapshot } from './types'
import type { TerminalHistoryLogBatch } from './terminal-history-log'

type AdapterInternals = {
  client: { request: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
  historyManager: HistoryManager
  checkpointSessions(
    sessionIds: Iterable<string>,
    opts?: { final?: boolean; teardown?: boolean }
  ): Promise<Set<string>>
  sessionsNeedingFullCheckpoint: Set<string>
  sessionsNeedingLiveCheckpoint: Set<string>
  lastFullCheckpointAt: Map<string, number>
  carriedUnloggedBatchesBySessionId: Map<string, TerminalHistoryLogBatch[]>
}

const MODES = {
  bracketedPaste: false,
  mouseTracking: false,
  applicationCursor: false,
  alternateScreen: false
}

function liveWindowSnapshot(): TerminalSnapshot {
  return {
    snapshotAnsi: 'LIVE-SCREEN\r\n',
    scrollbackAnsi: 'LIVE-WINDOW-ONLY\r\n',
    rehydrateSequences: '',
    cwd: '/tmp',
    modes: MODES,
    cols: 80,
    rows: 24,
    scrollbackLines: 1
  }
}

/** ~capBytes of 80-byte rows, each tagged so depth retention is observable. */
function fillerRows(capBytes: number): string {
  const rows: string[] = []
  let bytes = 0
  for (let i = 0; bytes < capBytes; i++) {
    const row = `log-line-${i}`.padEnd(78, '.')
    rows.push(row)
    bytes += row.length + 2
  }
  return `${rows.join('\r\n')}\r\n`
}

describe('log-cap rotation durable depth', () => {
  let historyDir: string
  let adapter: DaemonPtyAdapter
  let internals: AdapterInternals

  beforeEach(() => {
    historyDir = mkdtempSync(join(tmpdir(), 'orca-log-cap-'))
  })

  afterEach(() => {
    adapter?.dispose()
    rmSync(historyDir, { recursive: true, force: true })
  })

  function makeAdapter(takes: {
    refusedBatch: PendingOutputRecord[]
    refusedSeq: number
    snapshotSeq: number
    drainedRecords?: PendingOutputRecord[]
    overflowedFirstTake?: boolean
  }): AdapterInternals {
    adapter = new DaemonPtyAdapter({
      socketPath: join(historyDir, 'daemon.sock'),
      tokenPath: join(historyDir, 'daemon.token'),
      historyPath: historyDir
    })
    const request = vi.fn(async (type: string, payload: Record<string, unknown>) => {
      if (type !== 'takePendingOutput') {
        throw new Error(`unexpected request: ${type}`)
      }
      if (payload.includeSnapshot === true) {
        return {
          records: [],
          drainedRecords: takes.drainedRecords ?? [],
          seq: takes.snapshotSeq,
          overflowed: false,
          snapshot: liveWindowSnapshot()
        }
      }
      return {
        records: takes.refusedBatch,
        seq: takes.refusedSeq,
        overflowed: takes.overflowedFirstTake === true,
        snapshot: null
      }
    })
    const cast = adapter as unknown as AdapterInternals
    cast.client = { request, disconnect: vi.fn() }
    return cast
  }

  async function seedSessionWithNearCapLog(sessionId: string): Promise<void> {
    await internals.historyManager.openSession(sessionId, { cwd: '/tmp', cols: 80, rows: 24 })
    expect(internals.historyManager.isSessionDisabled(sessionId)).toBe(false)
    // One near-cap batch leaves the 5MiB log unable to take the next 100KB append.
    const seeded = await internals.historyManager.appendIncrements(sessionId, 1, [
      { kind: 'output', data: fillerRows(5_200_000) }
    ])
    expect(seeded).toBe('ok')
  }

  // Big enough that seeded log + this batch always projects past the 5MiB cap.
  function refusedMarkerBatch(): PendingOutputRecord[] {
    return [{ kind: 'output', data: `REFUSED-MARKER\r\n${'r'.repeat(100_000)}\r\n` }]
  }

  function readCheckpoint(sessionId: string): {
    scrollbackAnsi: string
    snapshotAnsi: string
    generation: number
    pendingOutputSeq?: number
    scrollbackLines: number
  } {
    const checkpointPath = join(historyDir, getHistorySessionDirName(sessionId), 'checkpoint.json')
    return JSON.parse(readFileSync(checkpointPath, 'utf-8'))
  }

  it('keeps deep log history and the refused batch in the rotated checkpoint', async () => {
    internals = makeAdapter({
      refusedBatch: refusedMarkerBatch(),
      refusedSeq: 2,
      snapshotSeq: 3,
      drainedRecords: [{ kind: 'output', data: 'DRAINED-MARKER\r\n' }]
    })
    await seedSessionWithNearCapLog('s1')

    await expect(internals.checkpointSessions(['s1'])).resolves.toEqual(new Set(['s1']))

    const checkpoint = readCheckpoint('s1')
    // Durable depth: thousands of log rows survive the rotation instead of the ~1-row live window.
    // Normal-screen serialization carries scrollback inside snapshotAnsi.
    const content = checkpoint.scrollbackAnsi + checkpoint.snapshotAnsi
    expect(checkpoint.scrollbackLines).toBeGreaterThan(1_000)
    expect(content).toContain('log-line-6')
    expect(content).toContain('REFUSED-MARKER')
    expect(content).toContain('DRAINED-MARKER')
    expect(content).not.toContain('LIVE-WINDOW-ONLY')
    expect(checkpoint.pendingOutputSeq).toBe(3)
    // The rotation still resets the log for the next generation.
    expect(internals.carriedUnloggedBatchesBySessionId.size).toBe(0)
  }, 30_000)

  it('carries the refused batch across the cooldown deferral without losing it', async () => {
    internals = makeAdapter({
      refusedBatch: refusedMarkerBatch(),
      refusedSeq: 2,
      snapshotSeq: 3,
      drainedRecords: []
    })
    await seedSessionWithNearCapLog('s2')
    internals.lastFullCheckpointAt.set('s2', Date.now())

    // Inside the cooldown: deferred, but the drained batch must not be dropped.
    await expect(internals.checkpointSessions(['s2'])).resolves.toEqual(new Set())
    expect(internals.sessionsNeedingFullCheckpoint.has('s2')).toBe(true)
    const carried = internals.carriedUnloggedBatchesBySessionId.get('s2')
    expect(carried?.flatMap((batch) => batch.records)).toEqual(refusedMarkerBatch())

    internals.lastFullCheckpointAt.set('s2', Date.now() - 46_000)
    await expect(internals.checkpointSessions(['s2'])).resolves.toEqual(new Set(['s2']))

    const checkpoint = readCheckpoint('s2')
    const content = checkpoint.scrollbackAnsi + checkpoint.snapshotAnsi
    expect(content).toContain('log-line-6')
    expect(content).toContain('REFUSED-MARKER')
    expect(internals.carriedUnloggedBatchesBySessionId.size).toBe(0)
  }, 30_000)

  it('re-anchors from the live window when pending output overflowed during cooldown', async () => {
    internals = makeAdapter({
      refusedBatch: [],
      refusedSeq: 2,
      snapshotSeq: 3,
      overflowedFirstTake: true
    })
    await seedSessionWithNearCapLog('s3')
    internals.lastFullCheckpointAt.set('s3', Date.now())

    await expect(internals.checkpointSessions(['s3'])).resolves.toEqual(new Set())
    // The overflow's dropped bytes are unrecoverable; the deferred retry must not
    // durable-rebuild over the hole.
    expect(internals.sessionsNeedingLiveCheckpoint.has('s3')).toBe(true)

    internals.lastFullCheckpointAt.set('s3', Date.now() - 46_000)
    await expect(internals.checkpointSessions(['s3'])).resolves.toEqual(new Set(['s3']))

    const checkpoint = readCheckpoint('s3')
    const content = checkpoint.scrollbackAnsi + checkpoint.snapshotAnsi
    expect(content).toContain('LIVE-WINDOW-ONLY')
    expect(content).not.toContain('log-line-6')
  }, 30_000)

  it('drops an oversized carry and re-anchors live instead of growing unbounded', async () => {
    internals = makeAdapter({
      refusedBatch: [{ kind: 'output', data: 'y'.repeat(4 * 1024 * 1024 + 1) }],
      refusedSeq: 2,
      snapshotSeq: 3
    })
    await seedSessionWithNearCapLog('s4')

    await expect(internals.checkpointSessions(['s4'])).resolves.toEqual(new Set(['s4']))

    expect(internals.carriedUnloggedBatchesBySessionId.size).toBe(0)
    const checkpoint = readCheckpoint('s4')
    // Carry over the memory bound falls back to the live re-anchor, like an overflow.
    expect(checkpoint.scrollbackAnsi + checkpoint.snapshotAnsi).toContain('LIVE-WINDOW-ONLY')
  }, 30_000)
})
