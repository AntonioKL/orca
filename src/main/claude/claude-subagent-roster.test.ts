import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentGroupBlock
} from '../../shared/native-chat-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { ClaudeSubagentRoster } from './claude-subagent-roster'

function harness(groupKey: string | null = 'claude-session:turn-1') {
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const tombstones: AgentJournalItemIdentity[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => items.push({ identity, body }),
    appendTombstone: (identity) => tombstones.push(identity),
    publish: vi.fn()
  }
  let clock = 1_000
  const roster = new ClaudeSubagentRoster({
    sink,
    currentGroupKey: () => groupKey,
    now: () => (clock += 1)
  })
  const roles = (): NativeChatSubagentEntry[] => {
    const body = items.at(-1)?.body
    if (!body || body.kind !== 'message') {
      return []
    }
    const block = body.blocks.find(
      (candidate): candidate is NativeChatSubagentGroupBlock => candidate.type === 'subagent-group'
    )
    return block ? block.agents : []
  }
  return { roster, items, tombstones, roles }
}

function system(subtype: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type: 'system', subtype, session_id: 'claude-session', ...fields }
}

function started(fields: Record<string, unknown>): Record<string, unknown> {
  return system('task_started', { task_type: 'local_agent', ...fields })
}

describe('ClaudeSubagentRoster', () => {
  it('builds the row from task_started, with the fallback sentence beside the block', () => {
    const { roster, items, roles } = harness()
    roster.observeSystemFrame(
      started({ task_id: 'task-1', tool_use_id: 'toolu_1', description: 'Review the diff' })
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.identity).toEqual({
      provider: 'orca',
      clientMessageId: 'claude-subagents:claude-session:turn-1'
    })
    const body = items[0]?.body
    expect(body?.kind === 'message' && body.blocks[0]).toEqual({
      type: 'text',
      text: 'Kicked off 1 subagent — 1 working'
    })
    expect(roles()).toEqual([
      expect.objectContaining({ id: 'task-1', label: 'Review the diff', state: 'working' })
    ])
  })

  it('keeps a backgrounded shell task out of the roster', () => {
    const { roster, items } = harness()
    roster.observeSystemFrame(
      system('task_started', {
        task_id: 'task-bash',
        tool_use_id: 'toolu_bash',
        task_type: 'local_bash',
        description: 'sleep 20',
        is_backgrounded: true
      })
    )
    roster.observeSystemFrame(
      system('task_updated', { task_id: 'task-bash', patch: { status: 'running' } })
    )
    // Its own frames carry a tool_use_id, so only the excluded-id memory stops it.
    roster.observeChildActivity('toolu_bash')
    expect(items).toHaveLength(0)
  })

  it('never renders a task marked skip_transcript', () => {
    const { roster, items } = harness()
    roster.observeSystemFrame(
      started({ task_id: 'task-a', tool_use_id: 'toolu_a', skip_transcript: true })
    )
    roster.observeSystemFrame(
      system('task_updated', { task_id: 'task-a', patch: { status: 'completed' } })
    )
    roster.observeChildActivity('toolu_a')
    expect(items).toHaveLength(0)
  })

  it('drops a provisional row once an announcement says the task is not a subagent', () => {
    const { roster, items, tombstones, roles } = harness()
    roster.observeChildActivity('toolu_bash')
    expect(roles()).toHaveLength(1)
    roster.observeSystemFrame(
      system('task_started', {
        task_id: 'task-bash',
        tool_use_id: 'toolu_bash',
        task_type: 'local_bash'
      })
    )
    expect(tombstones).toEqual([
      { provider: 'orca', clientMessageId: 'claude-subagents:claude-session:turn-1' }
    ])
    expect(items).toHaveLength(1)
  })

  it('does not duplicate a resumed task re-announced under a new tool_use_id', () => {
    const { roster, roles } = harness()
    roster.observeSystemFrame(
      started({ task_id: 'task-1', tool_use_id: 'toolu_first', description: 'Audit' })
    )
    roster.observeChildActivity('toolu_first')
    roster.observeSystemFrame(
      started({ task_id: 'task-1', tool_use_id: 'toolu_second', description: 'Audit' })
    )
    roster.observeChildActivity('toolu_second')
    expect(roles()).toEqual([
      expect.objectContaining({ id: 'task-1', label: 'Audit', state: 'working' })
    ])
  })

  it('adopts a row built from child traffic when the announcement finally names it', () => {
    const { roster, roles } = harness()
    roster.observeChildActivity('toolu_1')
    expect(roles()).toEqual([expect.objectContaining({ id: 'toolu_1', label: 'subagent' })])
    roster.observeSystemFrame(
      started({ task_id: 'task-1', tool_use_id: 'toolu_1', description: 'Explore' })
    )
    expect(roles()).toEqual([
      expect.objectContaining({ id: 'task-1', label: 'Explore', state: 'working' })
    ])
  })

  it('is idempotent: a repeated frame writes no new revision', () => {
    const { roster, items } = harness()
    const frame = started({ task_id: 'task-1', tool_use_id: 'toolu_1', description: 'Audit' })
    roster.observeSystemFrame(frame)
    roster.observeSystemFrame(frame)
    roster.observeSystemFrame(
      system('task_updated', { task_id: 'task-1', patch: { status: 'running' } })
    )
    expect(items).toHaveLength(1)
  })

  it('latches a terminal state against a later live report', () => {
    const { roster, roles } = harness()
    roster.observeSystemFrame(started({ task_id: 'task-1', description: 'Audit' }))
    roster.observeSystemFrame(
      system('task_updated', { task_id: 'task-1', patch: { status: 'failed' } })
    )
    roster.observeSystemFrame(
      system('task_updated', { task_id: 'task-1', patch: { status: 'running' } })
    )
    expect(roles()).toEqual([expect.objectContaining({ state: 'failed' })])
  })

  it('ignores an update for a task it never rostered', () => {
    const { roster, items } = harness()
    roster.observeSystemFrame(
      system('task_updated', { task_id: 'task-unknown', patch: { status: 'running' } })
    )
    expect(items).toHaveLength(0)
  })

  it('disambiguates children that share a description', () => {
    const { roster, roles } = harness()
    roster.observeSystemFrame(started({ task_id: 'task-1', description: 'Explore' }))
    roster.observeSystemFrame(started({ task_id: 'task-2', description: 'Explore' }))
    expect(roles().map((agent) => agent.label)).toEqual(['Explore', 'Explore 2'])
  })

  describe('turn end', () => {
    it('leaves a backgrounded child working and marks a foreground one unverifiable', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(started({ task_id: 'task-fg', description: 'Foreground' }))
      roster.observeSystemFrame(
        started({ task_id: 'task-bg', description: 'Background', is_backgrounded: true })
      )
      roster.settleTurn()
      expect(roles()).toEqual([
        expect.objectContaining({ label: 'Foreground', state: 'unverifiable' }),
        expect.objectContaining({ label: 'Background', state: 'working' })
      ])
    })

    it('never re-settles a child that already reported an outcome', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(started({ task_id: 'task-1', description: 'Audit' }))
      roster.observeSystemFrame(
        system('task_updated', { task_id: 'task-1', patch: { status: 'completed' } })
      )
      roster.settleTurn()
      expect(roles()).toEqual([expect.objectContaining({ state: 'completed' })])
    })

    it('sweeps backgrounded children only when the provider itself is gone', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(
        started({ task_id: 'task-bg', description: 'Background', is_backgrounded: true })
      )
      roster.settleTurn()
      roster.settleSession()
      expect(roles()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
    })
  })

  describe('spawn tool result', () => {
    it('settles a foreground child', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(started({ task_id: 'task-1', tool_use_id: 'toolu_1' }))
      roster.observeToolResult('toolu_1', false)
      expect(roles()).toEqual([expect.objectContaining({ state: 'completed' })])
    })

    it('reports a failed spawn as failed', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(started({ task_id: 'task-1', tool_use_id: 'toolu_1' }))
      roster.observeToolResult('toolu_1', true)
      expect(roles()).toEqual([expect.objectContaining({ state: 'failed' })])
    })

    it('ignores the immediate result a backgrounded spawn returns', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(
        started({ task_id: 'task-1', tool_use_id: 'toolu_1', is_backgrounded: true })
      )
      roster.observeToolResult('toolu_1', false)
      expect(roles()).toEqual([expect.objectContaining({ state: 'working' })])
    })

    it('ignores results for tools that are not spawn calls', () => {
      const { roster, items } = harness()
      roster.observeToolResult('toolu_read', false)
      expect(items).toHaveLength(0)
    })
  })

  it('groups children outside any turn under their own row', () => {
    const { roster, items } = harness(null)
    roster.observeSystemFrame(started({ task_id: 'task-1', description: 'Audit' }))
    expect(items[0]?.identity).toEqual({
      provider: 'orca',
      clientMessageId: 'claude-subagents:outside-turn'
    })
  })
})
