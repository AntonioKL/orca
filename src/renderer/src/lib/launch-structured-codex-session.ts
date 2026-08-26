import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../shared/structured-agent-session-mutation'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { useAppStore } from '@/store'
import {
  clearWebSessionFocusIntentIfMatches,
  recordWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from '@/runtime/web-session-focus-intent'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-tabs-sync'

function newSessionId(agent: 'claude' | 'codex'): string {
  return `${agent}_${crypto.randomUUID().replaceAll('-', '_')}`
}

export async function launchStructuredAgentSession(
  worktreeId: string,
  agent: 'claude' | 'codex'
): Promise<string> {
  const sessionId = newSessionId(agent)
  const fields = { worktree: toRuntimeWorktreeSelector(worktreeId), agent }
  const state = useAppStore.getState()
  recordWebSessionFocusIntent(
    { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
    worktreeId,
    `agent-session:${sessionId}`,
    undefined,
    resolveWebSessionVisibleTabId(state, worktreeId)
  )
  try {
    const result = await callStructuredAgentSession<
      AgentSessionMutationResult<AgentSessionAttachResult>
    >({ kind: 'local' }, 'agentSession.create', {
      envelope: {
        sessionId,
        clientOperationId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
        expectedRuntimeFence: null,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.create',
          sessionId,
          fields
        })
      },
      ...fields
    })
    if (!result.ok) {
      throw new Error(result.refusal.message)
    }
    return result.value.sessionId
  } catch (error) {
    // A concurrent create may have replaced this intent. Only clear the failed
    // session's slot; never erase a later successful create's focus request.
    clearWebSessionFocusIntentIfMatches(
      { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
      worktreeId,
      `agent-session:${sessionId}`
    )
    throw error
  }
}

export function launchStructuredCodexSession(worktreeId: string): Promise<string> {
  return launchStructuredAgentSession(worktreeId, 'codex')
}
