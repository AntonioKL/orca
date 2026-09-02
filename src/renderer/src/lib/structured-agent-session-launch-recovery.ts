import type { AgentSessionHistoryResult } from '../../../shared/agent-session-wire'
import {
  launchStructuredCodexSession,
  StructuredAgentSessionCreateRefusalError,
  type StructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-codex-session'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'

export type StructuredCodexLaunchReceipt = { sessionId: string; fence: number }

export type StructuredLaunchRecoveryState = {
  intent: StructuredAgentSessionLaunchIntent
  promise: Promise<StructuredCodexLaunchReceipt>
  visibilityUnknown: boolean
  cancelled: boolean
}

export class StructuredAgentSessionLaunchCancelledError extends Error {
  constructor() {
    super('structured session launch cancelled')
    this.name = 'StructuredAgentSessionLaunchCancelledError'
  }
}

function throwIfLaunchCancelled(state: StructuredLaunchRecoveryState): void {
  if (state.cancelled) {
    throw new StructuredAgentSessionLaunchCancelledError()
  }
}

async function verifyPublishedSession(state: StructuredLaunchRecoveryState): Promise<void> {
  const snapshots = await refreshLocalStructuredSessionTabs()
  throwIfLaunchCancelled(state)
  const published = snapshots.some(
    (snapshot) =>
      snapshot.worktree === state.intent.worktreeId &&
      snapshot.tabs.some(
        (tab) => tab.type === 'agent-session' && tab.sessionId === state.intent.sessionId
      )
  )
  if (!published) {
    throw new Error('structured session tab publication unavailable')
  }
}

async function recoverPublishedSessionReceipt(
  state: StructuredLaunchRecoveryState
): Promise<StructuredCodexLaunchReceipt> {
  await verifyPublishedSession(state)
  const history = await callStructuredAgentSession<AgentSessionHistoryResult>(
    { kind: 'local' },
    'agentSession.history',
    { sessionId: state.intent.sessionId, direction: 'tail', limit: 1 }
  )
  throwIfLaunchCancelled(state)
  const fence = history.page.fence ?? (!history.ok ? history.fence : undefined)
  if (typeof fence !== 'number') {
    throw new Error('structured session fence publication unavailable')
  }
  return { sessionId: state.intent.sessionId, fence }
}

async function retrySameIntent(
  state: StructuredLaunchRecoveryState,
  priorError: unknown
): Promise<StructuredCodexLaunchReceipt> {
  throwIfLaunchCancelled(state)
  try {
    const receipt = await launchStructuredCodexSession(state.intent)
    throwIfLaunchCancelled(state)
    await verifyPublishedSession(state)
    return receipt
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await recoverPublishedSessionReceipt(state)
    } catch {
      if (state.cancelled) {
        throw new StructuredAgentSessionLaunchCancelledError()
      }
      state.visibilityUnknown = true
      throw error ?? priorError
    }
  }
}

export async function launchAndReconcile(
  state: StructuredLaunchRecoveryState
): Promise<StructuredCodexLaunchReceipt> {
  throwIfLaunchCancelled(state)
  let receipt: StructuredCodexLaunchReceipt
  try {
    receipt = await launchStructuredCodexSession(state.intent)
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await recoverPublishedSessionReceipt(state)
    } catch {
      return retrySameIntent(state, error)
    }
  }
  try {
    throwIfLaunchCancelled(state)
    await verifyPublishedSession(state)
    return receipt
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    return retrySameIntent(state, error)
  }
}

export async function reconcileUnknownLaunch(
  state: StructuredLaunchRecoveryState
): Promise<StructuredCodexLaunchReceipt> {
  throwIfLaunchCancelled(state)
  state.visibilityUnknown = false
  try {
    return await recoverPublishedSessionReceipt(state)
  } catch (error) {
    return retrySameIntent(state, error)
  }
}
