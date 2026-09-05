import { describe, expect, it } from 'vitest'
import type { NativeChatBlock, NativeChatMessage } from '../../../shared/native-chat-types'
import type { OrchestrationWorkerReadResult } from '../../../shared/orchestration-worker-output'
import { formatWorkerRead } from './worker-output'

function transcriptRead(blocks: NativeChatBlock[]): OrchestrationWorkerReadResult {
  const message: NativeChatMessage = {
    id: 'm1',
    role: 'assistant',
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

describe('formatWorkerRead', () => {
  it('renders a spawn-group roster as the sentence a reader without the block sees', () => {
    const output = formatWorkerRead(
      transcriptRead([
        {
          type: 'subagent-group',
          groupId: 'thread:turn-1',
          agents: [
            { id: 'child-1', label: 'read', state: 'working' },
            { id: 'child-2', label: 'edit', state: 'failed' }
          ]
        }
      ])
    )

    expect(output).toBe('[assistant] [subagents] Kicked off 2 subagents — 1 working (1 failed)')
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
