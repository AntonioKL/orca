import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentHookServer listener replay', () => {
  it('does not let late same-turn working hooks resurrect an inferred interrupt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'long task', agentType: 'pi' }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'long task',
          baselineAgentType: 'pi',
          intent: 'ctrl-c'
        })
      ).toBe(true)

      vi.setSystemTime(6_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: {
            state: 'working',
            prompt: 'long task',
            agentType: 'pi',
            toolName: 'bash',
            toolInput: '/bin/sleep 90'
          }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'done',
          prompt: 'long task',
          agentType: 'pi',
          interrupted: true,
          receivedAt: 1_500,
          stateStartedAt: 1_500
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let late Claude tool hooks with explicit prompt resurrect an inferred interrupt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          hookEventName: 'UserPromptSubmit',
          payload: {
            state: 'working',
            prompt: 'Do I have gpu acceleration on on my terminal?',
            agentType: 'claude'
          }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'Do I have gpu acceleration on on my terminal?',
          baselineAgentType: 'claude',
          intent: 'ctrl-c'
        })
      ).toBe(true)

      vi.setSystemTime(2_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          hookEventName: 'PostToolUse',
          payload: {
            state: 'working',
            prompt: 'Do I have gpu acceleration on on my terminal?',
            agentType: 'claude',
            toolName: 'Read',
            toolInput: 'src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts'
          }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'done',
          prompt: 'Do I have gpu acceleration on on my terminal?',
          agentType: 'claude',
          interrupted: true,
          receivedAt: 1_500,
          stateStartedAt: 1_500
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let late Codex tool hooks with explicit prompt resurrect an inferred interrupt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          hookEventName: 'UserPromptSubmit',
          payload: {
            state: 'working',
            prompt: 'Run sleep 30, then reply done.',
            agentType: 'codex'
          }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'Run sleep 30, then reply done.',
          baselineAgentType: 'codex',
          intent: 'plain-escape'
        })
      ).toBe(true)

      vi.setSystemTime(6_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          hookEventName: 'PostToolUse',
          payload: {
            state: 'working',
            prompt: 'Run sleep 30, then reply done.',
            agentType: 'codex',
            toolName: 'Bash',
            toolInput: 'sleep 30'
          }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'done',
          prompt: 'Run sleep 30, then reply done.',
          agentType: 'codex',
          interrupted: true,
          receivedAt: 1_500,
          stateStartedAt: 1_500
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows a new prompt after an inferred interrupt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'first task', agentType: 'pi' }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'first task',
          baselineAgentType: 'pi',
          intent: 'ctrl-c'
        })
      ).toBe(true)

      vi.setSystemTime(2_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'second task', agentType: 'pi' }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          prompt: 'second task',
          agentType: 'pi',
          receivedAt: 2_000,
          stateStartedAt: 2_000
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows a Claude follow-up prompt after an inferred interrupt to keep working', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          hookEventName: 'UserPromptSubmit',
          payload: { state: 'working', prompt: 'first Claude turn', agentType: 'claude' }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'first Claude turn',
          baselineAgentType: 'claude',
          intent: 'ctrl-c'
        })
      ).toBe(true)

      vi.setSystemTime(2_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          hookEventName: 'UserPromptSubmit',
          payload: { state: 'working', prompt: 'second queued Claude turn', agentType: 'claude' }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          prompt: 'second queued Claude turn',
          agentType: 'claude',
          interrupted: undefined,
          receivedAt: 2_000,
          stateStartedAt: 2_000
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows an immediate same-prompt retry after an inferred interrupt', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          payload: { state: 'working', prompt: 'retryable task', agentType: 'pi' }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'retryable task',
          baselineAgentType: 'pi',
          intent: 'ctrl-c'
        })
      ).toBe(true)

      vi.setSystemTime(2_000)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          payload: { state: 'working', prompt: 'retryable task', agentType: 'pi' }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          prompt: 'retryable task',
          agentType: 'pi',
          receivedAt: 2_000,
          stateStartedAt: 2_000
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows same-turn Claude tool progress after the stale suppression window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          hookEventName: 'UserPromptSubmit',
          payload: { state: 'working', prompt: 'repeat task', agentType: 'claude' }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'repeat task',
          baselineAgentType: 'claude',
          intent: 'ctrl-c'
        })
      ).toBe(true)

      vi.setSystemTime(16_501)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          hasExplicitPrompt: true,
          hookEventName: 'PostToolUse',
          payload: {
            state: 'working',
            prompt: 'repeat task',
            agentType: 'claude',
            toolName: 'bash',
            toolInput: '/bin/sleep 90'
          }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          prompt: 'repeat task',
          agentType: 'claude',
          interrupted: undefined,
          receivedAt: 16_501,
          stateStartedAt: 16_501
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows generic non-explicit same-prompt working after the stale suppression window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'repeat task', agentType: 'pi' }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'repeat task',
          baselineAgentType: 'pi',
          intent: 'ctrl-c'
        })
      ).toBe(true)

      vi.setSystemTime(16_501)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'repeat task', agentType: 'pi' }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          prompt: 'repeat task',
          agentType: 'pi',
          interrupted: undefined,
          receivedAt: 16_501,
          stateStartedAt: 16_501
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows non-Claude tool-context working after the stale suppression window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = new AgentHookServer()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: 'repeat task', agentType: 'pi' }
        },
        'conn-1'
      )
      const baseline = server.getStatusSnapshot()[0]

      vi.setSystemTime(1_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'repeat task',
          baselineAgentType: 'pi',
          intent: 'ctrl-c'
        })
      ).toBe(true)

      vi.setSystemTime(16_501)
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: {
            state: 'working',
            prompt: 'repeat task',
            agentType: 'pi',
            toolName: 'bash',
            toolInput: '/bin/sleep 90'
          }
        },
        'conn-1'
      )

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'working',
          prompt: 'repeat task',
          agentType: 'pi',
          interrupted: undefined,
          toolName: 'bash',
          toolInput: '/bin/sleep 90',
          receivedAt: 16_501,
          stateStartedAt: 16_501
        })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows Codex tool progress after a request_user_input wait and interrupted turn', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const server = new AgentHookServer()
    try {
      await server.start({ env: 'production' })
      const postCodexHook = async (payload: Record<string, unknown>): Promise<void> => {
        const env = server.buildPtyEnv()
        const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })
        expect(response.status).toBe(204)
      }

      await postCodexHook({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'same turn'
      })
      vi.setSystemTime(1_100)
      await postCodexHook({
        hook_event_name: 'PreToolUse',
        prompt: 'same turn',
        tool_name: 'request_user_input',
        tool_input: {
          questions: [{ id: 'choice', question: 'Which color?', options: [{ label: 'Blue' }] }]
        }
      })
      // Mirrors the captured Codex shape: this auto-allowed tool parks the row while awaiting an answer.
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'waiting',
        prompt: 'same turn',
        toolName: 'request_user_input'
      })
      vi.setSystemTime(2_000)
      await postCodexHook({
        hook_event_name: 'PostToolUse',
        prompt: 'same turn',
        tool_name: 'request_user_input',
        tool_input: {
          questions: [{ id: 'choice', question: 'Which color?', options: [{ label: 'Blue' }] }]
        },
        tool_response: '{"answers":{"choice":{"answers":["Blue"]}}}'
      })
      const baseline = server.getStatusSnapshot()[0]
      expect(baseline).toMatchObject({ state: 'working', prompt: 'same turn' })
      vi.setSystemTime(2_500)
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: 'same turn',
          baselineAgentType: 'codex',
          intent: 'plain-escape'
        })
      ).toBe(true)

      vi.setSystemTime(18_501)
      await postCodexHook({
        hook_event_name: 'PreToolUse',
        prompt: 'same turn',
        tool_name: 'exec_command',
        tool_input: { cmd: 'pnpm test' }
      })
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        prompt: 'same turn',
        toolName: 'exec_command',
        interrupted: undefined,
        receivedAt: 18_501,
        stateStartedAt: 18_501
      })
    } finally {
      server.stop()
      vi.useRealTimers()
    }
  })
})
