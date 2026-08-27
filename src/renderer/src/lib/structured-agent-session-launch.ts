import { toast } from 'sonner'
import { launchStructuredAgentSession } from '@/lib/launch-structured-agent-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import { translate } from '@/i18n/i18n'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { agentSessionProviderLabel } from '../../../shared/agent-session-provider-label'

type StructuredLaunchState = {
  promise: Promise<string>
  sessionId?: string
  visibilityUnknown: boolean
}

const pendingStructuredLaunchesByKey = new Map<string, StructuredLaunchState>()

function structuredLaunchKey(worktreeId: string, agent: AgentSessionHandleProvider): string {
  return JSON.stringify([worktreeId, agent])
}

function trackLaunchSettlement(
  key: string,
  state: StructuredLaunchState,
  promise: Promise<string>
): void {
  void promise.then(
    () => {
      if (state.promise === promise && pendingStructuredLaunchesByKey.get(key) === state) {
        pendingStructuredLaunchesByKey.delete(key)
      }
    },
    () => {
      if (
        state.promise === promise &&
        !state.visibilityUnknown &&
        pendingStructuredLaunchesByKey.get(key) === state
      ) {
        pendingStructuredLaunchesByKey.delete(key)
      }
    }
  )
}

async function verifyPublishedSession(worktreeId: string, sessionId: string): Promise<string> {
  const snapshots = await refreshLocalStructuredSessionTabs()
  const published = snapshots.some(
    (snapshot) =>
      snapshot.worktree === worktreeId &&
      snapshot.tabs.some((tab) => tab.type === 'agent-session' && tab.sessionId === sessionId)
  )
  if (!published) {
    throw new Error('structured session tab publication unavailable')
  }
  return sessionId
}

function launchStructuredAgentSessionOnce(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): Promise<string> {
  const key = structuredLaunchKey(worktreeId, agent)
  const existing = pendingStructuredLaunchesByKey.get(key)
  if (existing) {
    if (existing.visibilityUnknown && existing.sessionId) {
      existing.visibilityUnknown = false
      existing.promise = verifyPublishedSession(worktreeId, existing.sessionId).catch((error) => {
        existing.visibilityUnknown = true
        throw error
      })
      trackLaunchSettlement(key, existing, existing.promise)
    }
    return existing.promise
  }
  // Keep the single-flight reservation through the inventory refresh. The
  // provider create can resolve before its published tab reaches the
  // renderer; clearing here lets a rapid second click create a sibling chat.
  const state: StructuredLaunchState = {
    promise: Promise.resolve(''),
    visibilityUnknown: false
  }
  state.promise = launchStructuredAgentSession(worktreeId, agent)
    .then((sessionId) => {
      state.sessionId = sessionId
      return verifyPublishedSession(worktreeId, sessionId)
    })
    .catch((error) => {
      if (state.sessionId) {
        state.visibilityUnknown = true
      }
      throw error
    })
  pendingStructuredLaunchesByKey.set(key, state)
  trackLaunchSettlement(key, state, state.promise)
  return state.promise
}

export function startStructuredAgentLaunch(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  openTerminalAgent: () => void
): void {
  const alreadyOpening = pendingStructuredLaunchesByKey.has(structuredLaunchKey(worktreeId, agent))
  const providerLabel = agentSessionProviderLabel(agent)
  toast.message(
    translate(
      alreadyOpening
        ? 'auto.components.nativeChat.structuredSessionLaunchInProgress'
        : 'auto.components.nativeChat.structuredSessionLaunchStarting',
      alreadyOpening
        ? '{{providerLabel}} chat is still opening'
        : 'Opening {{providerLabel}} chat…',
      { providerLabel }
    )
  )
  void launchStructuredAgentSessionOnce(worktreeId, agent).catch((error) => {
    toast.error(
      translate(
        'components.native-chat.structuredSessionLaunchFailed',
        'Could not open {{providerLabel}} chat',
        { providerLabel }
      ),
      {
        description: error instanceof Error ? error.message : String(error),
        action: {
          label: translate(
            'components.native-chat.structuredSessionLaunchTerminalAction',
            'Open terminal agent'
          ),
          onClick: openTerminalAgent
        }
      }
    )
  })
}
