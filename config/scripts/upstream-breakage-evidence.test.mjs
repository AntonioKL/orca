import { describe, expect, it } from 'vitest'

import {
  CHECK_KIND,
  MIN_WITNESSES,
  VERDICT,
  brokenAt,
  buildStacks,
  classifyChecks,
  compareVerdict,
  evidenceSpanHours,
  mainHealthVerdict,
  normalizeChecks,
  selectWitnessesInWindow
} from './upstream-breakage-evidence.mjs'

const HOUR = 3600 * 1000
const T0 = Date.parse('2026-08-30T03:00:00Z')

function check(name, conclusion, extra = {}) {
  return {
    name,
    status: 'completed',
    conclusion,
    appSlug: 'github-actions',
    completedAt: new Date(T0).toISOString(),
    ...extra
  }
}

// A usable witness with the given failures, all other named checks green.
function witness(ref, stackId, offsetMinutes, failures, ran = []) {
  const names = [...new Set([...failures, ...ran])]
  return {
    ref,
    stackId,
    usable: true,
    incomplete: 0,
    completedAt: new Date(T0 + offsetMinutes * 60 * 1000).toISOString(),
    failures: [...failures].sort(),
    ran: names.sort(),
    excluded: { rollup: [], knownFalse: [], foreignApp: [] }
  }
}

describe('normalizeChecks', () => {
  it('keeps a real failure and the checks that ran green', () => {
    const result = normalizeChecks([
      check('typecheck', 'failure'),
      check('static analysis', 'success')
    ])
    expect(result.failures).toEqual(['typecheck'])
    expect(result.ran).toEqual(['static analysis', 'typecheck'])
    expect(result.usable).toBe(true)
  })

  it('never counts the verify roll-up as an independent failure', () => {
    const result = normalizeChecks([check('verify', 'failure'), check('typecheck', 'failure')])
    expect(result.failures).toEqual(['typecheck'])
    expect(result.excluded.rollup).toEqual(['verify'])
  })

  it('does not report a green roll-up as an excluded red', () => {
    expect(
      normalizeChecks([check('verify', 'success'), check('typecheck', 'success')]).excluded.rollup
    ).toEqual([])
  })

  it('drops the known-false reds but reports what it dropped', () => {
    const result = normalizeChecks([
      check('test / tests node 24 1/8', 'failure'),
      check('test / tests node 24 6/8', 'failure'),
      check('e2e / ssh docker watcher isolation', 'failure'),
      check('test / tests node 24 2/8', 'failure')
    ])
    expect(result.failures).toEqual(['test / tests node 24 2/8'])
    expect(result.excluded.knownFalse).toHaveLength(3)
  })

  it('counts the known-false reds when explicitly asked to', () => {
    const result = normalizeChecks([check('test / tests node 24 1/8', 'failure')], {
      includeKnownFalse: true
    })
    expect(result.failures).toEqual(['test / tests node 24 1/8'])
  })

  it('ignores third-party app checks', () => {
    const result = normalizeChecks([
      check('Greptile Review', 'failure', { appSlug: 'greptile-apps' }),
      check('typecheck', 'success')
    ])
    expect(result.failures).toEqual([])
    expect(result.excluded.foreignApp).toEqual(['Greptile Review'])
  })

  it('treats a skipped check as not run rather than as a pass', () => {
    const result = normalizeChecks([check('package', 'skipped')])
    expect(result.ran).toEqual([])
    expect(result.usable).toBe(false)
  })

  it('is unusable while a check is still in progress', () => {
    const result = normalizeChecks([
      check('typecheck', null, { status: 'in_progress' }),
      check('static analysis', 'success')
    ])
    expect(result.usable).toBe(false)
    expect(result.incomplete).toBe(1)
  })

  it('counts a timed-out check as a failure', () => {
    expect(normalizeChecks([check('package', 'timed_out')]).failures).toEqual(['package'])
  })

  it('dedupes a check name a re-run posted twice', () => {
    const result = normalizeChecks([check('typecheck', 'failure'), check('typecheck', 'failure')])
    expect(result.failures).toEqual(['typecheck'])
  })

  it('reports the latest completion time it saw', () => {
    const later = new Date(T0 + HOUR).toISOString()
    const result = normalizeChecks([
      check('typecheck', 'success'),
      check('static analysis', 'success', { completedAt: later })
    ])
    expect(result.completedAt).toBe(later)
  })
})

describe('buildStacks', () => {
  it('puts unrelated PRs based on main in their own stacks', () => {
    const stacks = buildStacks([
      { number: 1, headRefName: 'a', baseRefName: 'main' },
      { number: 2, headRefName: 'b', baseRefName: 'main' }
    ])
    expect(stacks).toHaveLength(2)
  })

  it('groups a chain of stacked PRs into one stack', () => {
    const stacks = buildStacks([
      { number: 1, headRefName: 'a', baseRefName: 'main' },
      { number: 2, headRefName: 'b', baseRefName: 'a' },
      { number: 3, headRefName: 'c', baseRefName: 'b' }
    ])
    expect(stacks).toEqual([[1, 2, 3]])
  })

  it('groups a chain listed leaf-first', () => {
    const stacks = buildStacks([
      { number: 3, headRefName: 'c', baseRefName: 'b' },
      { number: 2, headRefName: 'b', baseRefName: 'a' },
      { number: 1, headRefName: 'a', baseRefName: 'main' }
    ])
    expect(stacks).toEqual([[1, 2, 3]])
  })

  it('keeps two separate chains separate', () => {
    const stacks = buildStacks([
      { number: 1, headRefName: 'a', baseRefName: 'main' },
      { number: 2, headRefName: 'b', baseRefName: 'a' },
      { number: 10, headRefName: 'x', baseRefName: 'main' },
      { number: 11, headRefName: 'y', baseRefName: 'x' }
    ])
    expect(stacks).toEqual([
      [1, 2],
      [10, 11]
    ])
  })
})

describe('evidenceSpanHours', () => {
  it('returns null when fewer than two witnesses carry a timestamp', () => {
    expect(evidenceSpanHours([witness('#1', 's1', 0, [])])).toBeNull()
    expect(evidenceSpanHours([{ ref: '#1' }, { ref: '#2' }])).toBeNull()
  })

  it('measures the spread between the earliest and latest witness', () => {
    const span = evidenceSpanHours([witness('#1', 's1', 0, []), witness('#2', 's2', 120, [])])
    expect(span).toBeCloseTo(2)
  })
})

describe('classifyChecks', () => {
  it('calls a check red in every witness that ran it always-red', () => {
    const result = classifyChecks([
      witness('#1', 's1', 0, ['typecheck']),
      witness('#2', 's2', 10, ['typecheck'])
    ])
    expect(result.upstream.map((c) => c.name)).toEqual(['typecheck'])
  })

  it('finds a break that opens partway through the window', () => {
    const result = classifyChecks([
      witness('#1', 's1', 0, [], ['typecheck']),
      witness('#2', 's2', 10, ['typecheck']),
      witness('#3', 's3', 20, ['typecheck'])
    ])
    expect(result.transitions).toHaveLength(1)
    expect(result.transitions[0].kind).toBe(CHECK_KIND.windowed)
    expect(result.transitions[0].lastGreenBefore).toBe(T0)
  })

  it('finds a break that opened and closed inside the window', () => {
    const result = classifyChecks([
      witness('#1', 's1', 0, [], ['typecheck']),
      witness('#2', 's2', 10, ['typecheck']),
      witness('#3', 's3', 20, ['typecheck']),
      witness('#4', 's4', 30, [], ['typecheck'])
    ])
    expect(result.transitions).toHaveLength(1)
    expect(result.transitions[0].firstGreenAfter).toBe(T0 + 30 * 60 * 1000)
  })

  it('calls interleaved reds and greens branch-specific', () => {
    const result = classifyChecks([
      witness('#1', 's1', 0, ['typecheck']),
      witness('#2', 's2', 10, [], ['typecheck']),
      witness('#3', 's3', 20, ['typecheck'])
    ])
    expect(result.branchSpecific.map((c) => c.name)).toEqual(['typecheck'])
    expect(result.transitions).toEqual([])
  })

  it('calls a lone red bracketed by greens branch-specific, not thin evidence', () => {
    const result = classifyChecks([
      witness('#1', 's1', 0, [], ['root directory guard']),
      witness('#2', 's2', 10, ['root directory guard']),
      witness('#3', 's3', 20, [], ['root directory guard'])
    ])
    expect(result.branchSpecific.map((c) => c.name)).toEqual(['root directory guard'])
    expect(result.inconclusive).toEqual([])
  })

  it('refuses to attribute a red confined to one stack', () => {
    const result = classifyChecks([
      witness('#1', 's1', 0, ['typecheck']),
      witness('#2', 's1', 10, ['typecheck'])
    ])
    expect(result.upstream).toEqual([])
    expect(result.inconclusive.map((c) => c.name)).toEqual(['typecheck'])
  })

  it('ignores witnesses whose checks never completed', () => {
    const stalled = { ...witness('#3', 's3', 5, ['typecheck']), usable: false }
    const result = classifyChecks([witness('#1', 's1', 0, ['typecheck']), stalled])
    expect(result.usableWitnesses).toBe(1)
  })

  it('reports identical failure sets across the failing witnesses', () => {
    const result = classifyChecks([
      witness('#1', 's1', 0, ['typecheck', 'static analysis']),
      witness('#2', 's2', 10, ['static analysis', 'typecheck'])
    ])
    expect(result.identicalAcrossFailing).toBe(true)
  })

  it('reports divergent failure sets as not identical', () => {
    const result = classifyChecks([
      witness('#1', 's1', 0, ['typecheck']),
      witness('#2', 's2', 10, ['package'])
    ])
    expect(result.identicalAcrossFailing).toBe(false)
  })
})

describe('brokenAt', () => {
  const windowed = classifyChecks([
    witness('#1', 's1', 0, [], ['typecheck']),
    witness('#2', 's2', 10, ['typecheck']),
    witness('#3', 's3', 20, ['typecheck']),
    witness('#4', 's4', 30, [], ['typecheck'])
  ]).transitions[0]

  it('is broken inside the red stretch', () => {
    expect(brokenAt(windowed, T0 + 15 * 60 * 1000)).toBe(true)
  })

  it('is not broken before the stretch opens', () => {
    expect(brokenAt(windowed, T0)).toBe(false)
  })

  it('is not broken after the stretch closes', () => {
    expect(brokenAt(windowed, T0 + 30 * 60 * 1000)).toBe(false)
  })

  it('is broken everywhere for an always-red check', () => {
    const always = classifyChecks([
      witness('#1', 's1', 0, ['typecheck']),
      witness('#2', 's2', 10, ['typecheck'])
    ]).upstream[0]
    expect(brokenAt(always, T0 - HOUR)).toBe(true)
  })

  it('is never broken for an interleaved check', () => {
    const interleaved = classifyChecks([
      witness('#1', 's1', 0, ['typecheck']),
      witness('#2', 's2', 10, [], ['typecheck']),
      witness('#3', 's3', 20, ['typecheck'])
    ]).branchSpecific[0]
    expect(brokenAt(interleaved, T0 + 5 * 60 * 1000)).toBe(false)
  })
})

describe('mainHealthVerdict', () => {
  it('reports broken and names the checks', () => {
    const classification = classifyChecks([
      witness('#1', 's1', 0, [], ['typecheck']),
      witness('#2', 's2', 10, ['typecheck']),
      witness('#3', 's3', 20, ['typecheck'])
    ])
    const verdict = mainHealthVerdict(classification, T0 + 15 * 60 * 1000)
    expect(verdict.verdict).toBe(VERDICT.broken)
    expect(verdict.brokenChecks).toEqual(['typecheck'])
  })

  it('answers unknown, never clean, with a single witness', () => {
    const verdict = mainHealthVerdict(classifyChecks([witness('#1', 's1', 0, [])]), T0)
    expect(verdict.verdict).toBe(VERDICT.unknown)
  })

  it('answers unknown when every witness is in one stack', () => {
    const classification = classifyChecks([witness('#1', 's1', 0, []), witness('#2', 's1', 10, [])])
    expect(mainHealthVerdict(classification, T0).verdict).toBe(VERDICT.unknown)
  })

  it('answers unknown when the witnesses observed different mains', () => {
    const classification = classifyChecks([
      witness('#1', 's1', 0, []),
      witness('#2', 's2', 60 * 48, [])
    ])
    const verdict = mainHealthVerdict(classification, T0)
    expect(verdict.verdict).toBe(VERDICT.unknown)
    expect(verdict.why).toContain('different mains')
  })

  it('answers unknown in the blind gap between the last green and the first red', () => {
    const classification = classifyChecks([
      witness('#1', 's1', 0, [], ['typecheck']),
      witness('#2', 's2', 20, ['typecheck']),
      witness('#3', 's3', 30, ['typecheck'])
    ])
    const verdict = mainHealthVerdict(classification, T0 + 10 * 60 * 1000)
    expect(verdict.verdict).toBe(VERDICT.unknown)
    expect(verdict.why).toContain('no witness at the commit itself')
  })

  it('answers unknown when a failing check was seen too narrowly', () => {
    const classification = classifyChecks([
      witness('#1', 's1', 0, ['package']),
      witness('#2', 's2', 10, []),
      witness('#3', 's3', 20, [])
    ])
    expect(mainHealthVerdict(classification, T0 + 5 * 60 * 1000).verdict).toBe(VERDICT.unknown)
  })

  it('reports clean only with corroborating independent witnesses', () => {
    const classification = classifyChecks([
      witness('#1', 's1', 0, [], ['typecheck']),
      witness('#2', 's2', 10, [], ['typecheck'])
    ])
    expect(mainHealthVerdict(classification, T0 + 5 * 60 * 1000).verdict).toBe(VERDICT.clean)
  })

  it('needs at least the documented number of witnesses', () => {
    expect(MIN_WITNESSES).toBe(2)
  })
})

describe('compareVerdict', () => {
  it('calls an identical failure set across independent stacks upstream', () => {
    const classification = classifyChecks([
      witness('#1', 's1', 0, ['typecheck']),
      witness('#2', 's2', 10, ['typecheck'])
    ])
    expect(compareVerdict(classification).verdict).toBe(VERDICT.upstream)
  })

  it('calls differing failure sets divergent', () => {
    const classification = classifyChecks([
      witness('#1', 's1', 0, ['typecheck']),
      witness('#2', 's2', 10, ['package'])
    ])
    expect(compareVerdict(classification).verdict).toBe(VERDICT.divergent)
  })

  it('will not call one stack upstream on its own', () => {
    const classification = classifyChecks([
      witness('#1', 's1', 0, ['typecheck']),
      witness('#2', 's1', 10, ['typecheck'])
    ])
    expect(compareVerdict(classification).verdict).toBe(VERDICT.sharedAncestor)
  })

  it('refuses identical failures whose checks ran days apart', () => {
    const classification = classifyChecks([
      witness('#1', 's1', 0, ['typecheck']),
      witness('#2', 's2', 60 * 71, ['typecheck'])
    ])
    const verdict = compareVerdict(classification)
    expect(verdict.verdict).toBe(VERDICT.unknown)
    expect(verdict.why).toContain('different mains')
  })

  it('reports no-failures when nothing is red', () => {
    const classification = classifyChecks([
      witness('#1', 's1', 0, [], ['typecheck']),
      witness('#2', 's2', 10, [], ['typecheck'])
    ])
    expect(compareVerdict(classification).verdict).toBe(VERDICT.noFailures)
  })

  it('will not judge a single red ref', () => {
    const classification = classifyChecks([
      witness('#1', 's1', 0, ['typecheck'], ['typecheck', 'package']),
      witness('#2', 's2', 10, [], ['package'])
    ])
    expect(compareVerdict(classification).verdict).toBe(VERDICT.unknown)
  })
})

describe('selectWitnessesInWindow', () => {
  const from = new Date(T0)
  const to = new Date(T0 + HOUR)

  it('keeps a witness whose CI completed inside the window', () => {
    expect(selectWitnessesInWindow([witness('#1', 's1', 30, [])], from, to)).toHaveLength(1)
  })

  it('drops a witness whose CI completed before the window', () => {
    expect(selectWitnessesInWindow([witness('#1', 's1', -30, [])], from, to)).toEqual([])
  })

  it('drops a witness with no completion time rather than assuming it fits', () => {
    expect(selectWitnessesInWindow([{ ref: '#1', completedAt: null }], from, to)).toEqual([])
  })
})
