import { describe, expect, it } from 'vitest'
import { collectPaneAgentIdentityEvidence } from './pane-agent-identity-evidence'
import {
  AgentTitleParserDifferentialCensus,
  PaneAgentIdentityAvailabilityCensus,
  classifyAgentTitleParserDifferential,
  getPaneAgentEvidenceSourceMask
} from './pane-agent-identity-census'

describe('PaneAgentIdentityAvailabilityCensus', () => {
  it('records every privacy-safe availability bucket', () => {
    const census = new PaneAgentIdentityAvailabilityCensus()
    const observe = (
      collected: ReturnType<typeof collectPaneAgentIdentityEvidence>,
      runKeyAvailability: 'present' | 'old-peer' | 'missing' = 'present'
    ) => census.observe({ hostKind: 'ssh', launchMode: 'typed', runKeyAvailability, collected })

    observe(collectPaneAgentIdentityEvidence({}), 'missing')
    observe(collectPaneAgentIdentityEvidence({ title: { agent: 'claude' } }))
    observe(
      collectPaneAgentIdentityEvidence({
        liveHook: { agent: 'claude' },
        launch: { agent: 'claude' }
      }),
      'old-peer'
    )
    observe(
      {
        evidence: [
          { source: 'live-hook', agent: 'claude' },
          { source: 'live-hook', agent: 'codex' }
        ],
        routingPolicy: {}
      },
      'missing'
    )

    expect(census.snapshot()).toEqual([
      {
        hostKind: 'ssh',
        launchMode: 'typed',
        sourceMask: 0,
        snapshots: 1,
        noEvidence: 1,
        titleOnly: 0,
        noNonTitleEvidence: 1,
        ambiguousTopRank: 0,
        oldPeerOrNoRunKey: 1
      },
      {
        hostKind: 'ssh',
        launchMode: 'typed',
        sourceMask: 1,
        snapshots: 1,
        noEvidence: 0,
        titleOnly: 0,
        noNonTitleEvidence: 0,
        ambiguousTopRank: 1,
        oldPeerOrNoRunKey: 1
      },
      {
        hostKind: 'ssh',
        launchMode: 'typed',
        sourceMask: 5,
        snapshots: 1,
        noEvidence: 0,
        titleOnly: 0,
        noNonTitleEvidence: 0,
        ambiguousTopRank: 0,
        oldPeerOrNoRunKey: 1
      },
      {
        hostKind: 'ssh',
        launchMode: 'typed',
        sourceMask: 64,
        snapshots: 1,
        noEvidence: 0,
        titleOnly: 1,
        noNonTitleEvidence: 1,
        ambiguousTopRank: 0,
        oldPeerOrNoRunKey: 0
      }
    ])
  })

  it('uses a source-presence bitmask without retaining agent values', () => {
    const collected = collectPaneAgentIdentityEvidence({
      process: { agent: 'codex' },
      completedHook: { agent: 'claude' },
      title: { agent: 'gemini' }
    })
    expect(getPaneAgentEvidenceSourceMask(collected)).toBe(2 | 8 | 64)
    const census = new PaneAgentIdentityAvailabilityCensus()
    census.observe({
      hostKind: 'wsl-distro',
      launchMode: 'unknown',
      runKeyAvailability: 'missing',
      collected
    })
    expect(JSON.stringify(census.snapshot())).not.toMatch(/codex|claude|gemini/)
  })
})

describe('agent title parser differential', () => {
  it.each([
    ['codex.exe', 'agreement'],
    ['codex and grok', 'legacy-only'],
    ['✳', 'canonical-only'],
    ['Switch Claude and Codex off… - grok', 'disagreement']
  ] as const)('classifies %j as %s', (title, category) => {
    expect(classifyAgentTitleParserDifferential(title)).toBe(category)
  })

  it('aggregates categories without retaining title text', () => {
    const census = new AgentTitleParserDifferentialCensus()
    for (const title of ['codex.exe', 'codex and grok', '✳', 'Switch Codex off… - grok']) {
      census.observe(title)
    }
    expect(census.snapshot()).toEqual({
      agreement: 1,
      'legacy-only': 1,
      'canonical-only': 1,
      disagreement: 1
    })
    expect(JSON.stringify(census.snapshot())).not.toContain('codex')
  })
})
