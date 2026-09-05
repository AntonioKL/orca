import { describe, expect, it } from 'vitest'
import { subagentGroupFallbackText } from '../../../shared/native-chat-subagent-summary'
import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatSubagentEntry
} from '../../../shared/native-chat-types'
import type { OrchestrationWorkerReadResult } from '../../../shared/orchestration-worker-output'
import { formatWorkerRead } from './worker-output'

function transcriptRead(
  blocks: NativeChatBlock[],
  role: NativeChatMessage['role'] = 'assistant'
): OrchestrationWorkerReadResult {
  const message: NativeChatMessage = {
    id: 'm1',
    role,
    blocks,
    timestamp: 1,
    source: 'transcript'
  }
  return {
    dispatchId: 'd1',
    source: 'transcript',
    sourceIdentity: 'pane:1',
    provider: 'codex',
    transcript: { messages: [message], nextCursor: '1', limited: false, returnedMessageCount: 1 },
    cursor: '1',
    status: { worker: 'running', terminal: 'running' },
    fallbackReason: null,
    warnings: []
  }
}

const ROSTER: readonly NativeChatSubagentEntry[] = [
  { id: 'child-1', label: 'read', state: 'working' },
  { id: 'child-2', label: 'edit', state: 'failed' }
]

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('formatWorkerRead', () => {
  // The replay case this row is durable for: SQLite-backed, re-sent on every
  // reconnect, and read here by a client that draws no roster block, runs no
  // reconciliation, and cannot re-check whether those children still exist. A
  // sentence frozen mid-flight outlives the process that wrote it, so it must
  // not keep asserting a liveness only that process could have observed —
  // `docs/reference/ssh-execution-boundary.md` calls that loss of contact
  // reported as a live state.
  it('replays a mid-flight roster row without claiming a child is still working', () => {
    const midFlight: readonly NativeChatSubagentEntry[] = [
      { id: 'child-1', label: 'read', state: 'working' },
      { id: 'child-2', label: 'search', state: 'working' },
      { id: 'child-3', label: 'edit', state: 'failed' }
    ]

    const output = formatWorkerRead(
      transcriptRead([
        { type: 'text', text: subagentGroupFallbackText(midFlight) },
        { type: 'subagent-group', groupId: 'thread:turn-1', agents: [...midFlight] }
      ])
    )

    expect(output).toBe('[assistant] Kicked off 3 subagents (1 failed)')
    expect(output).not.toMatch(/\bworking\b/)
  })

  // The body `codexSubagentGroupBody` actually writes: the plain-text twin, then
  // the block it stands in for. The twin exists for clients that cannot draw the
  // block, so a client printing the block must not print the twin beside it —
  // the renderer drops the twin for the same reason, from the other side.
  it('prints the roster sentence once for the two-block row the producer writes', () => {
    const sentence = subagentGroupFallbackText(ROSTER)
    const output = formatWorkerRead(
      transcriptRead(
        [
          { type: 'text', text: sentence },
          { type: 'subagent-group', groupId: 'thread:turn-1', agents: [...ROSTER] }
        ],
        'system'
      )
    )

    expect(output).toBe(`[system] ${sentence}`)
    expect(occurrences(output, sentence)).toBe(1)
  })

  // A group with no twin beside it is a shape the block schema admits and no
  // producer writes. Dropping it would lose the roster entirely, so the block
  // itself carries the sentence when nothing else does.
  it('stands in for a roster block that arrived without its twin', () => {
    const output = formatWorkerRead(
      transcriptRead([{ type: 'subagent-group', groupId: 'thread:turn-1', agents: [...ROSTER] }])
    )

    expect(output).toBe(`[assistant] [subagents] ${subagentGroupFallbackText(ROSTER)}`)
  })

  // A roster from a newer build holds a state this build does not know, which
  // `summarizeSubagentGroup` reads as `unverifiable`. Recomputing the sentence
  // to compare it against the frozen twin therefore produced a DIFFERENT string,
  // and the CLI printed the roster twice: the twin's own wording plus a
  // `[subagents]` line contradicting it.
  it('prints the roster once when the twin names a state this build cannot reproduce', () => {
    const frozenTwin = 'Ran 2 subagents (1 cancelled)'
    const output = formatWorkerRead(
      transcriptRead(
        [
          { type: 'text', text: frozenTwin },
          {
            type: 'subagent-group',
            groupId: 'thread:turn-1',
            agents: [
              { id: 'child-1', label: 'read', state: 'completed' },
              { id: 'child-2', label: 'edit', state: 'cancelled' }
            ] as unknown as NativeChatSubagentEntry[]
          }
        ],
        'system'
      )
    )

    expect(output).toBe(`[system] ${frozenTwin}`)
    expect(output).not.toContain('[subagents]')
    expect(output).not.toContain('unverifiable')
  })

  // The journal admits block types this build does not know, and `client.call`
  // casts the RPC result rather than validating it — so a newer remote host's
  // block reaches this formatter as-is. Reading fields off it threw a TypeError
  // and took down the whole `worker read`.
  it('degrades an unknown block type from a newer host instead of throwing', () => {
    const output = formatWorkerRead(
      transcriptRead([
        { type: 'text', text: 'before' },
        { type: 'plan-step', title: 'ship it' } as unknown as NativeChatBlock,
        { type: 'text', text: 'after' }
      ])
    )

    expect(output).toBe('[assistant] before\n[unsupported block]\nafter')
  })
})
