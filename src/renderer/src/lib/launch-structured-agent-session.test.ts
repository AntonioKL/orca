import { beforeEach, describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { launchStructuredAgentSession } from './launch-structured-agent-session'

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn()
}))

describe('structured agent launch', () => {
  beforeEach(() => {
    vi.mocked(callStructuredAgentSession).mockReset()
  })

  it.each<AgentSessionHandleProvider>(['claude', 'codex'])(
    'creates a %s native session with a provider-explicit host-verifiable launch intent',
    async (agent) => {
      vi.mocked(callStructuredAgentSession).mockImplementation(
        async (_target, _method, params) => ({
          ok: true,
          replayed: false,
          fence: 1,
          cursor: { epoch: 'epoch-1', sequence: 0 },
          value: {
            sessionId: (params as { envelope: { sessionId: string } }).envelope.sessionId,
            fence: 1,
            snapshot: { cursor: { epoch: 'epoch-1', sequence: 0 }, items: [] },
            unconfirmedClientMessageIds: []
          }
        })
      )

      const sessionId = await launchStructuredAgentSession('workspace-1', agent)
      const params = vi.mocked(callStructuredAgentSession).mock.calls[0]?.[2] as {
        envelope: { sessionId: string; payloadFingerprint: string }
        worktree: string
        agent: AgentSessionHandleProvider
      }

      expect(sessionId).toMatch(new RegExp(`^${agent}_[A-Za-z0-9_]{36}$`))
      expect(callStructuredAgentSession).toHaveBeenCalledWith(
        { kind: 'local' },
        'agentSession.create',
        expect.objectContaining({ worktree: 'id:workspace-1', agent })
      )
      expect(params.agent).toBe(agent)
      expect(params.envelope.payloadFingerprint).toBe(
        structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.create',
          sessionId: params.envelope.sessionId,
          fields: { worktree: 'id:workspace-1', agent }
        })
      )
    }
  )
})
