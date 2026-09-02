import { describe, expect, it } from 'vitest'
import { PaneAgentIdentityComparisonRecorder } from '../../../shared/pane-agent-identity-comparison'
import { recordTabAgentLadderComparison } from './tab-agent-identity-comparison'
import { resolveTabAgentFromSignals } from './use-tab-agent'

const GROK_ADVERSARIAL_TITLE = 'STA-4011 Linux Antigravity Commit Messages - grok'

describe('tab-icon comparison lane', () => {
  it('counts the title-above-hook reclaim that the rendered ladder allows and the canonical one refuses', () => {
    // The rendered tab ladder consults the title before the completed hook, so a reused-looking
    // title flips the icon. The canonical ladder keeps the completed hook until a run-key
    // supersession proves a reclaim. This exact disagreement is what the window must surface.
    const signals = {
      hasObservedAgentSignal: true,
      isRemote: false,
      title: GROK_ADVERSARIAL_TITLE,
      hookAgent: null,
      focusedCompletedHookAgent: 'claude' as const,
      launchAgent: undefined
    }
    const rendered = resolveTabAgentFromSignals(signals)
    expect(rendered).toBe('grok')

    const recorder = new PaneAgentIdentityComparisonRecorder()
    recordTabAgentLadderComparison(
      {
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        isRemote: false,
        title: signals.title,
        hookAgent: signals.hookAgent,
        focusedCompletedHookAgent: signals.focusedCompletedHookAgent,
        launchAgent: null
      },
      rendered,
      recorder
    )
    expect(recorder.snapshot()).toMatchObject({
      comparisons: 1,
      disagreements: 1,
      reclaimShapes: 1
    })
  })

  it('agreement on a hook-covered pane records a comparison and no disagreement', () => {
    const recorder = new PaneAgentIdentityComparisonRecorder()
    recordTabAgentLadderComparison(
      {
        tabId: 'tab-2',
        worktreeId: 'wt-1',
        isRemote: false,
        title: 'anything at all',
        hookAgent: 'claude',
        launchAgent: null
      },
      'claude',
      recorder
    )
    expect(recorder.snapshot()).toMatchObject({ comparisons: 1, disagreements: 0 })
  })

  it('an uncovered pane preserves the rendered result as the compatibility lane', () => {
    const recorder = new PaneAgentIdentityComparisonRecorder()
    recordTabAgentLadderComparison(
      {
        tabId: 'tab-3',
        worktreeId: 'wt-1',
        isRemote: false,
        title: GROK_ADVERSARIAL_TITLE,
        hookAgent: null,
        launchAgent: null
      },
      'grok',
      recorder
    )
    expect(recorder.snapshot()).toMatchObject({
      comparisons: 1,
      disagreements: 0,
      uncovered: 1
    })
  })

  it('dedupes repeated renders of unchanged signals', () => {
    const recorder = new PaneAgentIdentityComparisonRecorder()
    const args = {
      tabId: 'tab-4',
      worktreeId: 'wt-1',
      isRemote: false,
      title: 'plain shell',
      hookAgent: null,
      launchAgent: null
    }
    recordTabAgentLadderComparison(args, null, recorder)
    recordTabAgentLadderComparison(args, null, recorder)
    expect(recorder.snapshot().comparisons).toBe(1)
  })

  it('a remote pane is recorded with remote host scope, never resolved differently', () => {
    const emitted: Record<string, unknown>[] = []
    const recorder = new PaneAgentIdentityComparisonRecorder((_line, detail) => {
      if (detail && 'surface' in detail) {
        emitted.push(detail)
      }
    })
    recordTabAgentLadderComparison(
      {
        tabId: 'tab-5',
        worktreeId: 'wt-1',
        isRemote: true,
        title: GROK_ADVERSARIAL_TITLE,
        hookAgent: null,
        focusedCompletedHookAgent: 'claude',
        launchAgent: null
      },
      'grok',
      recorder
    )
    expect(emitted[0]).toMatchObject({ hostScope: 'remote' })
  })
})
