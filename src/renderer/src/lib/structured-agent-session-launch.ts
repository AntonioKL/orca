import { toast } from 'sonner'
import { launchStructuredCodexSession } from '@/lib/launch-structured-codex-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import { translate } from '@/i18n/i18n'

type StructuredLaunchState = {
  promise: Promise<string>
  sessionId?: string
  visibilityUnknown: boolean
}

const pendingStructuredLaunchesByWorktree = new Map<string, StructuredLaunchState>()

function trackLaunchSettlement(
  worktreeId: string,
  state: StructuredLaunchState,
  promise: Promise<string>
): void {
  void promise.then(
    () => {
      if (
        state.promise === promise &&
        pendingStructuredLaunchesByWorktree.get(worktreeId) === state
      ) {
        pendingStructuredLaunchesByWorktree.delete(worktreeId)
      }
    },
    () => {
      if (
        state.promise === promise &&
        !state.visibilityUnknown &&
        pendingStructuredLaunchesByWorktree.get(worktreeId) === state
      ) {
        pendingStructuredLaunchesByWorktree.delete(worktreeId)
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

function launchStructuredCodexSessionOnce(worktreeId: string): Promise<string> {
  const existing = pendingStructuredLaunchesByWorktree.get(worktreeId)
  if (existing) {
    if (existing.visibilityUnknown && existing.sessionId) {
      existing.visibilityUnknown = false
      existing.promise = verifyPublishedSession(worktreeId, existing.sessionId).catch((error) => {
        existing.visibilityUnknown = true
        throw error
      })
      trackLaunchSettlement(worktreeId, existing, existing.promise)
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
  state.promise = launchStructuredCodexSession(worktreeId)
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
  pendingStructuredLaunchesByWorktree.set(worktreeId, state)
  trackLaunchSettlement(worktreeId, state, state.promise)
  return state.promise
}

export function startStructuredCodexLaunch(worktreeId: string): void {
  const alreadyOpening = pendingStructuredLaunchesByWorktree.has(worktreeId)
  toast.message(
    translate(
      alreadyOpening
        ? 'auto.components.nativeChat.structuredSessionLaunchInProgress'
        : 'auto.components.nativeChat.structuredSessionLaunchStarting',
      alreadyOpening ? 'Codex chat is still opening' : 'Opening Codex chat…'
    )
  )
  void launchStructuredCodexSessionOnce(worktreeId).catch((error) => {
    toast.error(
      translate(
        'components.native-chat.structuredSessionLaunchFailed',
        'Could not open Codex chat'
      ),
      { description: error instanceof Error ? error.message : String(error) }
    )
  })
}
