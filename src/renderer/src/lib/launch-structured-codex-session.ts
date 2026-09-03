import type {
  AgentSessionAttachResult,
  AgentSessionMutationEnvelope,
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

type StructuredAgentSessionCreateParams = {
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: 'codex'
}

export type StructuredAgentSessionLaunchIntent = {
  sessionId: string
  worktreeId: string
  params: StructuredAgentSessionCreateParams
}

export class StructuredAgentSessionCreateRefusalError extends Error {}

export function createStructuredCodexSessionLaunchIntent(
  worktreeId: string
): StructuredAgentSessionLaunchIntent {
  const sessionId = `codex_${crypto.randomUUID().replaceAll('-', '_')}`
  const fields = { worktree: toRuntimeWorktreeSelector(worktreeId), agent: 'codex' as const }
  const state = useAppStore.getState()
  recordWebSessionFocusIntent(
    { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
    worktreeId,
    `agent-session:${sessionId}`,
    undefined,
    resolveWebSessionVisibleTabId(state, worktreeId)
  )
  return {
    sessionId,
    worktreeId,
    params: {
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
    }
  }
}

export function abandonStructuredAgentSessionLaunchIntent(
  intent: StructuredAgentSessionLaunchIntent
): void {
  clearWebSessionFocusIntentIfMatches(
    { environmentId: LOCAL_STRUCTURED_SESSION_OWNER },
    intent.worktreeId,
    `agent-session:${intent.sessionId}`
  )
}

/** The host refuses some launches by THROWING rather than returning a refusal
 *  envelope -- an unsupported location, or a runtime that needs repair. Those
 *  are still definitive refusals, but callers engage their legacy-terminal
 *  fallback on the refusal class alone, so an unmapped throw strands the launch
 *  with no agent pane and the prompt left in the outbox. */
const THROWN_REFUSAL_MARKERS = [
  'structured_agent_session_unsupported',
  'Project runtime requires repair'
] as const

export function isThrownStructuredRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return THROWN_REFUSAL_MARKERS.some((marker) => message.includes(marker))
}

export async function launchStructuredCodexSession(
  intent: StructuredAgentSessionLaunchIntent
): Promise<Pick<AgentSessionAttachResult, 'sessionId' | 'fence'>> {
  let result: AgentSessionMutationResult<AgentSessionAttachResult>
  try {
    result = await callStructuredAgentSession<
      AgentSessionMutationResult<AgentSessionAttachResult>
    >({ kind: 'local' }, 'agentSession.create', intent.params)
  } catch (error) {
    if (!isThrownStructuredRefusal(error)) {
      throw error
    }
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateRefusalError(
      error instanceof Error ? error.message : 'structured_agent_session_unsupported'
    )
  }
  if (!result.ok) {
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateRefusalError(result.refusal.message)
  }
  return { sessionId: result.value.sessionId, fence: result.value.fence }
}
