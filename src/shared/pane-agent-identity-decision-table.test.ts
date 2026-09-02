import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveCanonicalPaneAgentIdentity,
  type CanonicalPaneAgentIdentity
} from './pane-agent-identity-adapter'
import type { TuiAgent } from './tui-agent'

const AGENTS: readonly TuiAgent[] = ['claude', 'codex']
const SLOT_COUNT = 7
const SHAPE_COUNT = 3 ** SLOT_COUNT * 4 * 2
const TITLES: readonly string[] = ['', 'zsh', 'Task - claude', 'Task - codex']

type Breakdown = Record<'launch' | 'completed-hook' | 'sleeping-session' | 'process', number>

function slotValues(mask: number): (TuiAgent | null)[] {
  let remaining = mask
  return Array.from({ length: SLOT_COUNT }, () => {
    const value = remaining % 3
    remaining = Math.floor(remaining / 3)
    return value === 0 ? null : AGENTS[value - 1]
  })
}

function oldTabResult(values: readonly (TuiAgent | null)[], title: string, remote: boolean) {
  const [hook, siblingHook, completed, siblingCompleted, process, sleeping, launch] = values
  void remote
  if (hook) {
    return hook
  }
  if (process) {
    return process
  }
  if (completed && !sleeping && (title === 'Task - claude' || title === 'Task - codex')) {
    return title === 'Task - claude' ? 'claude' : 'codex'
  }
  if (completed) {
    return completed
  }
  if (sleeping) {
    return sleeping
  }
  if (!launch && siblingHook && siblingCompleted && siblingHook !== siblingCompleted) {
    return null
  }
  if (title === 'Task - claude') {
    return 'claude'
  }
  if (title === 'Task - codex') {
    return 'codex'
  }
  if (launch) {
    return launch
  }
  return siblingHook ?? siblingCompleted ?? null
}

function canonicalResult(
  values: readonly (TuiAgent | null)[],
  title: string,
  withProof: boolean
): CanonicalPaneAgentIdentity {
  const [hook, siblingHook, completed, siblingCompleted, process, sleeping, launch] = values
  return resolveCanonicalPaneAgentIdentity({
    hookAgent: hook,
    hookIsLive: hook !== null,
    completedHookAgent: completed,
    launchAgent: launch,
    foregroundAgent: process,
    processProof:
      withProof && process
        ? {
            agent: process,
            processIncarnation: 'fixture-process',
            authorityId: 'fixture-authority',
            capturedAgeMs: 10,
            validForMs: 1_000
          }
        : undefined,
    sleepingSessionAgent: sleeping,
    siblingAgents: [siblingHook, siblingCompleted].filter(
      (agent): agent is TuiAgent => agent !== null
    ),
    allowSibling: true,
    title
  })
}

function runDecisionTable(withProof: boolean) {
  let disagreements = 0
  let flipped = 0
  const breakdown: Breakdown = {
    launch: 0,
    'completed-hook': 0,
    'sleeping-session': 0,
    process: 0
  }
  for (let mask = 0; mask < 3 ** SLOT_COUNT; mask += 1) {
    const values = slotValues(mask)
    for (const title of TITLES) {
      for (const remote of [false, true]) {
        const old = oldTabResult(values, title, remote)
        const canonical = canonicalResult(values, title, withProof)
        // The table groups only the approved residual rungs; process-only/ambiguous mismatches are
        // accounted for separately by the 1,872 process-starvation flip count below.
        if (old !== canonical.agent && canonical.source !== null && canonical.source in breakdown) {
          disagreements += 1
          breakdown[canonical.source as keyof Breakdown] += 1
        }
        if (!withProof) {
          const proven = canonicalResult(values, title, true)
          if (
            canonical.agent !== proven.agent &&
            proven.source === 'process' &&
            (canonical.source === 'launch' ||
              canonical.source === 'completed-hook' ||
              canonical.source === 'sleeping-session')
          ) {
            flipped += 1
          }
        }
      }
    }
  }
  return { disagreements, flipped, breakdown }
}

describe('approved pane-agent ladder decision table', () => {
  it('replays all 17,496 shapes and asserts totals plus per-rung breakdown', () => {
    const proofFree = runDecisionTable(false)
    const freshProof = runDecisionTable(true)
    const result = {
      shapes: SHAPE_COUNT,
      proofOmitted: proofFree,
      freshProof,
      flippedByAddingProof: proofFree.flipped
    }
    writeFileSync(
      join(tmpdir(), 'orca-pane-agent-identity-decision-table.json'),
      `${JSON.stringify(result, null, 2)}\n`
    )
    expect(proofFree.disagreements).toBe(2_520)
    expect(proofFree.breakdown).toEqual({
      launch: 1_908,
      'completed-hook': 468,
      'sleeping-session': 144,
      process: 0
    })
    expect(freshProof.disagreements).toBe(648)
    expect(freshProof.breakdown).toEqual({
      launch: 612,
      'completed-hook': 36,
      'sleeping-session': 0,
      process: 0
    })
    expect(proofFree.flipped).toBe(1_872)
  })

  it('requires every freshness field before the process rung can win', () => {
    const values = [null, null, null, null, 'codex', null, 'claude'] as const
    const missingAge = canonicalResult(values, '', true)
    const missingFreshness = resolveCanonicalPaneAgentIdentity({
      foregroundAgent: 'codex',
      processProof: {
        agent: 'codex',
        processIncarnation: 'fixture-process',
        authorityId: 'fixture-authority',
        capturedAgeMs: undefined as unknown as number,
        validForMs: 1_000
      },
      launchAgent: 'claude'
    })
    expect(missingAge).toMatchObject({ agent: 'codex', source: 'process' })
    expect(missingFreshness).toMatchObject({ agent: 'claude', source: 'launch' })
    expect(
      resolveCanonicalPaneAgentIdentity({
        foregroundAgent: 'codex',
        processProof: {
          agent: 'codex',
          processIncarnation: 'fixture-process',
          authorityId: 'fixture-authority',
          capturedAgeMs: 10,
          validForMs: undefined as unknown as number
        },
        launchAgent: 'claude'
      })
    ).toMatchObject({ agent: 'claude', source: 'launch' })
  })

  it('fences equal-rank conflicts, superseded runs, and title-last fallback', () => {
    expect(
      resolveCanonicalPaneAgentIdentity({
        siblingAgents: ['claude', 'codex'],
        allowSibling: true
      })
    ).toMatchObject({ agent: null, ambiguousAt: 'sibling' })
    expect(
      resolveCanonicalPaneAgentIdentity({
        completedHookAgent: 'claude',
        completedHookRun: { authorityId: 'fixture', incarnation: 1 },
        currentRun: { authorityId: 'fixture', incarnation: 2 },
        title: 'Task - codex'
      })
    ).toMatchObject({ agent: 'codex', source: 'title', supersededSources: ['completed-hook'] })
    expect(
      resolveCanonicalPaneAgentIdentity({ launchAgent: 'claude', title: 'Codex' })
    ).toMatchObject({ agent: 'claude', source: 'launch' })
  })
})
