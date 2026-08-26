import { describe, expect, it } from 'vitest'
import { collectPaneAgentIdentityEvidence } from './pane-agent-identity-evidence'

describe('collectPaneAgentIdentityEvidence', () => {
  it('assembles facts in resolver order without probing', () => {
    const run = { authorityId: 'host-a', incarnation: 7 }
    expect(
      collectPaneAgentIdentityEvidence({
        title: { agent: 'cursor' },
        sibling: { agent: 'grok' },
        sleepingSession: { agent: 'gemini' },
        completedHook: { agent: 'claude' },
        launch: { agent: 'codex', run },
        process: { agent: 'opencode' },
        liveHook: { agent: 'aider' }
      }).evidence
    ).toEqual([
      { source: 'live-hook', agent: 'aider' },
      { source: 'process', agent: 'opencode' },
      { source: 'launch', agent: 'codex', run },
      { source: 'completed-hook', agent: 'claude' },
      { source: 'sleeping-session', agent: 'gemini' },
      { source: 'sibling', agent: 'grok' },
      { source: 'title', agent: 'cursor' }
    ])
  })

  it('owner-normalizes Pi-compatible live, process, and completed evidence', () => {
    const result = collectPaneAgentIdentityEvidence({
      compatibilityOwnerAgent: 'omp',
      liveHook: { agent: 'pi' },
      process: { agent: 'pi' },
      launch: { agent: 'omp' },
      completedHook: { agent: 'pi' },
      sibling: { agent: 'pi' },
      title: { agent: 'pi' }
    })
    expect(result.evidence.map(({ source, agent }) => [source, agent])).toEqual([
      ['live-hook', 'omp'],
      ['process', 'omp'],
      ['launch', 'omp'],
      ['completed-hook', 'omp'],
      ['sibling', 'pi'],
      ['title', 'pi']
    ])
  })

  it('does not manufacture process evidence from the Windows WSL proxy', () => {
    expect(
      collectPaneAgentIdentityEvidence({
        process: { agent: 'claude', authority: 'wsl-host-proxy' },
        title: { agent: 'claude' }
      }).evidence
    ).toEqual([{ source: 'title', agent: 'claude' }])
  })

  it('keeps routing policy facts separate from identity evidence', () => {
    const result = collectPaneAgentIdentityEvidence({
      process: { agent: 'codex' },
      routingPolicy: {
        routingTrusted: false,
        routingRevoked: true,
        routingConfirmationPending: true,
        shellForeground: false
      }
    })
    expect(result.evidence).toEqual([{ source: 'process', agent: 'codex' }])
    expect(result.routingPolicy).toEqual({
      routingTrusted: false,
      routingRevoked: true,
      routingConfirmationPending: true,
      shellForeground: false
    })
  })
})
