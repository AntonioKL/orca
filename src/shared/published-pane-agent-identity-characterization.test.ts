import { describe, expect, it } from 'vitest'
import { PaneAgentIdentityComparisonRecorder } from './pane-agent-identity-comparison'
import { resolvePublishedPaneAgentIdentity } from './published-pane-agent-identity'
import { comparePublishedPaneAgentIdentity } from './published-pane-agent-identity-comparison'
import type { TuiAgent } from './tui-agent'

/**
 * Output-neutral characterization of the FROZEN host publication adapter. The host wave may only
 * replace the frozen call after this table and the real-session comparison window are green, so
 * every evidence shape the adapter accepts is pinned here byte-for-byte. These are observations
 * of current behavior, not aspirations — do not "fix" a row without the host-wave migration.
 */

type Shape = {
  name: string
  args: {
    hookAgent?: TuiAgent | null
    hookIsLive?: boolean
    launchAgent?: TuiAgent | null
    foregroundAgent?: TuiAgent | null
    title?: string | null
  }
  expected: TuiAgent | undefined
}

const GROK_ADVERSARIAL_TITLE = 'STA-4011 Linux Antigravity Commit Messages - grok'

const SHAPES: readonly Shape[] = [
  { name: 'nothing known', args: {}, expected: undefined },
  {
    name: 'all null/empty values',
    args: { hookAgent: null, launchAgent: null, foregroundAgent: null, title: '' },
    expected: undefined
  },
  { name: 'live hook only', args: { hookAgent: 'claude', hookIsLive: true }, expected: 'claude' },
  {
    name: 'completed hook only',
    args: { hookAgent: 'codex', hookIsLive: false },
    expected: 'codex'
  },
  { name: 'launch only', args: { launchAgent: 'gemini' }, expected: 'gemini' },
  { name: 'foreground only', args: { foregroundAgent: 'codex' }, expected: 'codex' },
  { name: 'unambiguous title only', args: { title: GROK_ADVERSARIAL_TITLE }, expected: 'grok' },
  {
    name: 'free-text title mention only',
    args: { title: 'Review the Claude session-history fix' },
    expected: undefined
  },
  {
    name: 'live hook beats foreground',
    args: { hookAgent: 'claude', hookIsLive: true, foregroundAgent: 'codex' },
    expected: 'claude'
  },
  {
    name: 'foreground beats launch (frozen process rung, no proof required)',
    args: { launchAgent: 'claude', foregroundAgent: 'codex' },
    expected: 'codex'
  },
  {
    name: 'launch beats completed hook',
    args: { hookAgent: 'codex', hookIsLive: false, launchAgent: 'claude' },
    expected: 'claude'
  },
  {
    name: 'launch beats unambiguous title',
    args: { launchAgent: 'claude', title: GROK_ADVERSARIAL_TITLE },
    expected: 'claude'
  },
  {
    name: 'completed hook beats unambiguous title',
    args: { hookAgent: 'claude', hookIsLive: false, title: GROK_ADVERSARIAL_TITLE },
    expected: 'claude'
  },
  {
    name: 'duplicate agreeing sources',
    args: {
      hookAgent: 'claude',
      hookIsLive: true,
      launchAgent: 'claude',
      foregroundAgent: 'claude',
      title: 'claude'
    },
    expected: 'claude'
  },
  {
    name: 'full conflict resolves to strongest',
    args: {
      hookAgent: 'claude',
      hookIsLive: true,
      launchAgent: 'gemini',
      foregroundAgent: 'codex',
      title: GROK_ADVERSARIAL_TITLE
    },
    expected: 'claude'
  }
]

describe('frozen host adapter characterization', () => {
  for (const shape of SHAPES) {
    it(`publishes ${shape.expected ?? 'nothing'} for: ${shape.name}`, () => {
      expect(resolvePublishedPaneAgentIdentity(shape.args)).toBe(shape.expected)
    })
  }
})

describe('comparison wrapper output-neutrality', () => {
  it('returns the frozen result verbatim for every characterized shape', () => {
    const recorder = new PaneAgentIdentityComparisonRecorder()
    for (const shape of SHAPES) {
      const wrapped = comparePublishedPaneAgentIdentity(
        {
          ...shape.args,
          surface: 'terminal-summary',
          paneId: `pane:${shape.name}`,
          worktreeId: 'wt',
          hostScope: 'local'
        },
        recorder
      )
      expect(wrapped).toBe(resolvePublishedPaneAgentIdentity(shape.args))
    }
    expect(recorder.snapshot().comparisons).toBe(SHAPES.length)
  })

  it('counts the frozen-vs-canonical divergence instead of publishing it', () => {
    const recorder = new PaneAgentIdentityComparisonRecorder()
    // The frozen ladder lets a bare foreground NAME outrank the launch record; the canonical
    // ladder demands a host process proof for that rung. The published value must stay the
    // frozen one while the disagreement is counted — that count is the migration gate.
    const published = comparePublishedPaneAgentIdentity(
      {
        launchAgent: 'claude',
        foregroundAgent: 'codex',
        surface: 'terminal-summary',
        paneId: 'pane:process-demotion',
        worktreeId: 'wt',
        hostScope: 'local'
      },
      recorder
    )
    expect(published).toBe('codex')
    expect(recorder.snapshot()).toMatchObject({ comparisons: 1, disagreements: 1 })
  })

  it('records the reclaim/bad-hook input shape separately', () => {
    const recorder = new PaneAgentIdentityComparisonRecorder()
    comparePublishedPaneAgentIdentity(
      {
        hookAgent: 'claude',
        hookIsLive: false,
        title: GROK_ADVERSARIAL_TITLE,
        surface: 'terminal-summary',
        paneId: 'pane:reclaim-shape',
        worktreeId: 'wt',
        hostScope: 'local'
      },
      recorder
    )
    expect(recorder.snapshot()).toMatchObject({ comparisons: 1, reclaimShapes: 1 })
  })

  it('skips recomputation for consecutive identical pane inputs but still returns the frozen value', () => {
    const recorder = new PaneAgentIdentityComparisonRecorder()
    const args = {
      launchAgent: 'claude' as const,
      surface: 'terminal-summary' as const,
      paneId: 'pane:dedupe',
      worktreeId: 'wt',
      hostScope: 'local' as const
    }
    expect(comparePublishedPaneAgentIdentity(args, recorder)).toBe('claude')
    expect(comparePublishedPaneAgentIdentity(args, recorder)).toBe('claude')
    expect(recorder.snapshot().comparisons).toBe(1)
  })
})
