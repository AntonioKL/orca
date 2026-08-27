import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneAgentIdentityCensus } from './pane-agent-identity-census'

describe('PaneAgentIdentityCensus', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules relay-only deltas and preserves relay coverage host attribution', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const census = new PaneAgentIdentityCensus(emit)
    const row = ['relay', 'typed', 1, 0, 0, 0, 0] as const

    census.ingestRelaySnapshot('env', { epoch: 'e', revision: 1, rows: [row] })
    vi.advanceTimersByTime(300_000)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith([
      { kind: 'coverage', host_kind: 'relay', reason: 'snapshot', count: 1 },
      { kind: 'coverage', host_kind: 'relay', reason: 'baseline', count: 1 }
    ])
    emit.mockClear()

    census.ingestRelaySnapshot('env', {
      epoch: 'e',
      revision: 2,
      rows: [['relay', 'typed', 2, 0, 0, 0, 0]],
      candidateCoverage: [['relay', 2]]
    })
    expect(emit).not.toHaveBeenCalled()
    expect(census.snapshot().candidateCoverage).toBeUndefined()

    vi.advanceTimersByTime(300_000)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'aggregate',
          host_kind: 'relay',
          attested_runs: 1
        }),
        expect.objectContaining({
          kind: 'coverage',
          host_kind: 'relay',
          reason: 'snapshot',
          count: 1
        }),
        expect.objectContaining({
          kind: 'coverage',
          host_kind: 'relay',
          reason: 'candidate',
          count: 2
        })
      ])
    )
    census.shutdown()
  })

  it('reports baselines and epoch resets without re-emitting cumulative history', () => {
    const emit = vi.fn()
    const census = new PaneAgentIdentityCensus(emit)
    census.ingestRelaySnapshot('env', {
      epoch: 'before',
      revision: 1,
      rows: [['relay', 'typed', 2, 1, 0, 1, 0]],
      candidateCoverage: [['relay', 3]]
    })
    census.flush()
    emit.mockClear()

    census.ingestRelaySnapshot('env', {
      epoch: 'after',
      revision: 1,
      rows: [['relay', 'typed', 4, 1, 1, 1, 0]],
      candidateCoverage: [['relay', 5]]
    })
    census.flush()

    census.ingestRelaySnapshot('env', {
      epoch: 'after',
      revision: 2,
      rows: [['relay', 'typed', 5, 1, 2, 1, 0]],
      candidateCoverage: [['relay', 6]]
    })
    census.flush()

    expect(emit.mock.calls.map(([rows]) => rows)).toEqual([
      [
        { kind: 'coverage', host_kind: 'relay', reason: 'snapshot', count: 1 },
        { kind: 'coverage', host_kind: 'relay', reason: 'epoch_changed', count: 1 }
      ],
      [
        {
          kind: 'aggregate',
          host_kind: 'relay',
          launch_mode: 'typed',
          attested_runs: 1,
          no_evidence: 0,
          title_only: 1,
          identity_null: 0,
          ambiguous_top_rank: 0
        },
        { kind: 'coverage', host_kind: 'relay', reason: 'snapshot', count: 1 },
        { kind: 'coverage', host_kind: 'relay', reason: 'candidate', count: 1 }
      ]
    ])
    census.shutdown()
  })
})
