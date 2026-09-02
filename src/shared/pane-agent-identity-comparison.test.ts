import { describe, expect, it } from 'vitest'
import {
  PaneAgentIdentityComparisonRecorder,
  type PaneIdentityComparisonInput
} from './pane-agent-identity-comparison'

function sample(overrides: Partial<PaneIdentityComparisonInput> = {}): PaneIdentityComparisonInput {
  return {
    surface: 'terminal-summary',
    paneId: 'tab-1:leaf-1',
    worktreeId: 'wt-1',
    oldAgent: 'claude',
    newAgent: 'claude',
    newSource: 'launch',
    coverage: 'covered',
    titleOnly: false,
    runKeyComparability: 'absent',
    hostScope: 'local',
    ambiguous: false,
    reclaimShape: false,
    ...overrides
  }
}

describe('comparison counters', () => {
  it('counts disagreements and both absence-transition directions separately', () => {
    const recorder = new PaneAgentIdentityComparisonRecorder()
    recorder.record(sample())
    recorder.record(sample({ oldAgent: 'codex', newAgent: 'claude' }))
    recorder.record(sample({ oldAgent: null, newAgent: 'claude' }))
    recorder.record(sample({ oldAgent: 'claude', newAgent: null, newSource: null }))
    expect(recorder.snapshot()).toMatchObject({
      comparisons: 4,
      disagreements: 3,
      oldAbsentNewPresent: 1,
      oldPresentNewAbsent: 1
    })
  })

  it('counts ambiguity, reclaim shapes, title-only, and uncovered lanes', () => {
    const recorder = new PaneAgentIdentityComparisonRecorder()
    recorder.record(sample({ ambiguous: true }))
    recorder.record(sample({ reclaimShape: true }))
    recorder.record(sample({ titleOnly: true, coverage: 'uncovered' }))
    expect(recorder.snapshot()).toMatchObject({
      ambiguous: 1,
      reclaimShapes: 1,
      titleOnly: 1,
      uncovered: 1
    })
  })
})

describe('sampling and bounds', () => {
  it('skips consecutive identical input signatures per pane, and resumes on change', () => {
    const recorder = new PaneAgentIdentityComparisonRecorder()
    expect(recorder.shouldCompare('tab-icon', 'tab-1', 'sig-a')).toBe(true)
    expect(recorder.shouldCompare('tab-icon', 'tab-1', 'sig-a')).toBe(false)
    expect(recorder.shouldCompare('tab-icon', 'tab-2', 'sig-a')).toBe(true)
    expect(recorder.shouldCompare('tab-icon', 'tab-1', 'sig-b')).toBe(true)
    expect(recorder.shouldCompare('tab-icon', 'tab-1', 'sig-a')).toBe(true)
  })

  it('emits one detail record per distinct disagreement shape, hard-capped', () => {
    const emitted: Record<string, unknown>[] = []
    const recorder = new PaneAgentIdentityComparisonRecorder((_line, detail) => {
      if (detail && 'surface' in detail) {
        emitted.push(detail)
      }
    })
    recorder.record(sample({ oldAgent: 'codex' }))
    recorder.record(sample({ oldAgent: 'codex' }))
    expect(emitted).toHaveLength(1)
    for (let i = 0; i < 100; i += 1) {
      recorder.record(sample({ oldAgent: `agent-${i}` }))
    }
    expect(emitted.length).toBeLessThanOrEqual(41)
    expect(recorder.snapshot().disagreements).toBe(102)
  })
})

describe('privacy contract', () => {
  it('emitted records pseudonymize ids and never contain a title-like payload', () => {
    const rawTitle = 'SECRET /Users/someone/private/path — do not leak'
    const emitted: { line: string; detail?: Record<string, unknown> }[] = []
    const recorder = new PaneAgentIdentityComparisonRecorder((line, detail) => {
      emitted.push({ line, detail })
    })
    recorder.record(
      sample({ paneId: 'raw-pane-id', worktreeId: 'raw-worktree-id', oldAgent: 'codex' })
    )
    expect(emitted.length).toBeGreaterThan(0)
    for (const { line, detail } of emitted) {
      const serialized = `${line} ${JSON.stringify(detail ?? {})}`
      expect(serialized).not.toContain(rawTitle)
      expect(serialized).not.toContain('raw-pane-id')
      expect(serialized).not.toContain('raw-worktree-id')
      expect(detail).not.toHaveProperty('title')
    }
  })

  it('two recorders pseudonymize the same id differently (per-process salt)', () => {
    const captured: string[] = []
    const capture = (_line: string, detail?: Record<string, unknown>) => {
      if (detail && typeof detail.pane === 'string') {
        captured.push(detail.pane)
      }
    }
    const a = new PaneAgentIdentityComparisonRecorder(capture)
    const b = new PaneAgentIdentityComparisonRecorder(capture)
    a.record(sample({ oldAgent: 'codex' }))
    b.record(sample({ oldAgent: 'codex' }))
    expect(captured).toHaveLength(2)
    expect(captured[0]).not.toBe(captured[1])
  })
})
