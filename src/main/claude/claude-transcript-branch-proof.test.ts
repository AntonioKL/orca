import { describe, expect, it } from 'vitest'
import { proveClaudeTranscriptBranchFromJsonl } from './claude-transcript-branch-proof'

describe('Claude transcript branch proof', () => {
  it('accepts a new leaf on a sibling branch as diagnostic evidence', () => {
    const contents = [
      JSON.stringify({ uuid: 'root', parentUuid: null, sessionId: 'session-1' }),
      JSON.stringify({ uuid: 'old-leaf', parentUuid: 'root', sessionId: 'session-1' }),
      JSON.stringify({ uuid: 'new-leaf', parentUuid: 'root', sessionId: 'session-1' }),
      JSON.stringify({ type: 'last-prompt', sessionId: 'session-1', leafUuid: 'new-leaf' })
    ].join('\n')
    expect(
      proveClaudeTranscriptBranchFromJsonl({
        contents,
        providerSessionId: 'session-1',
        previousLeafUuid: 'old-leaf'
      })
    ).toEqual({ leafUuid: 'new-leaf', relation: 'sibling' })
  })
})
