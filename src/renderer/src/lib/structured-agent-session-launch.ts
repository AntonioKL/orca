import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import {
  createStructuredCodexSessionLaunchIntent,
  abandonStructuredAgentSessionLaunchIntent,
  launchStructuredCodexSession,
  StructuredAgentSessionCreateRefusalError,
  type StructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-codex-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

type StructuredLaunchState = {
  intent: StructuredAgentSessionLaunchIntent
  promise: Promise<string>
  visibilityUnknown: boolean
  cancelled: boolean
}

export type StructuredCodexLaunchStatus = 'idle' | 'pending' | 'unknown'

const pendingStructuredLaunchesByWorktree = new Map<string, StructuredLaunchState>()
const structuredLaunchListeners = new Set<() => void>()

function notifyStructuredLaunchListeners(): void {
  for (const listener of structuredLaunchListeners) {
    listener()
  }
}

export function subscribeStructuredCodexLaunchStatus(listener: () => void): () => void {
  structuredLaunchListeners.add(listener)
  return () => structuredLaunchListeners.delete(listener)
}

export function getStructuredCodexLaunchStatus(worktreeId: string): StructuredCodexLaunchStatus {
  const state = pendingStructuredLaunchesByWorktree.get(worktreeId)
  if (!state) {
    return 'idle'
  }
  return state.visibilityUnknown ? 'unknown' : 'pending'
}

export function useStructuredCodexLaunchStatus(worktreeId: string): StructuredCodexLaunchStatus {
  return useSyncExternalStore(
    subscribeStructuredCodexLaunchStatus,
    () => getStructuredCodexLaunchStatus(worktreeId),
    () => 'idle'
  )
}

class StructuredAgentSessionLaunchCancelledError extends Error {
  constructor() {
    super('structured session launch cancelled')
    this.name = 'StructuredAgentSessionLaunchCancelledError'
  }
}

function throwIfLaunchCancelled(state: StructuredLaunchState): void {
  if (state.cancelled) {
    throw new StructuredAgentSessionLaunchCancelledError()
  }
}

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
        notifyStructuredLaunchListeners()
      }
    },
    () => {
      if (
        state.promise === promise &&
        !state.visibilityUnknown &&
        pendingStructuredLaunchesByWorktree.get(worktreeId) === state
      ) {
        pendingStructuredLaunchesByWorktree.delete(worktreeId)
        notifyStructuredLaunchListeners()
      }
    }
  )
}

async function verifyPublishedSession(intent: StructuredAgentSessionLaunchIntent): Promise<string> {
  const snapshots = await refreshLocalStructuredSessionTabs()
  const published = snapshots.some(
    (snapshot) =>
      snapshot.worktree === intent.worktreeId &&
      snapshot.tabs.some(
        (tab) => tab.type === 'agent-session' && tab.sessionId === intent.sessionId
      )
  )
  if (!published) {
    throw new Error('structured session tab publication unavailable')
  }
  const adopted = useAppStore
    .getState()
    .unifiedTabsByWorktree[intent.worktreeId]?.some(
      (tab) =>
        tab.contentType === 'agent-session' &&
        tab.entityId === intent.sessionId &&
        tab.worktreeId === intent.worktreeId
    )
  if (!adopted) {
    throw new Error('structured session tab adoption unavailable')
  }
  return intent.sessionId
}

async function retrySameIntent(state: StructuredLaunchState, priorError: unknown): Promise<string> {
  throwIfLaunchCancelled(state)
  try {
    await launchStructuredCodexSession(state.intent)
    throwIfLaunchCancelled(state)
    return await verifyPublishedSession(state.intent)
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await verifyPublishedSession(state.intent)
    } catch {
      if (state.cancelled) {
        throw new StructuredAgentSessionLaunchCancelledError()
      }
      state.visibilityUnknown = true
      notifyStructuredLaunchListeners()
      throw error ?? priorError
    }
  }
}

async function launchAndReconcile(state: StructuredLaunchState): Promise<string> {
  throwIfLaunchCancelled(state)
  try {
    await launchStructuredCodexSession(state.intent)
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await verifyPublishedSession(state.intent)
    } catch {
      return retrySameIntent(state, error)
    }
  }
  try {
    throwIfLaunchCancelled(state)
    return await verifyPublishedSession(state.intent)
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    return retrySameIntent(state, error)
  }
}

async function reconcileUnknownLaunch(state: StructuredLaunchState): Promise<string> {
  throwIfLaunchCancelled(state)
  state.visibilityUnknown = false
  notifyStructuredLaunchListeners()
  try {
    return await verifyPublishedSession(state.intent)
  } catch (error) {
    return retrySameIntent(state, error)
  }
}

function launchStructuredCodexSessionOnce(worktreeId: string): Promise<string> {
  const existing = pendingStructuredLaunchesByWorktree.get(worktreeId)
  if (existing) {
    if (existing.visibilityUnknown) {
      existing.promise = reconcileUnknownLaunch(existing)
      trackLaunchSettlement(worktreeId, existing, existing.promise)
    }
    return existing.promise
  }
  const state: StructuredLaunchState = {
    intent: createStructuredCodexSessionLaunchIntent(worktreeId),
    promise: Promise.resolve(''),
    visibilityUnknown: false,
    cancelled: false
  }
  state.promise = launchAndReconcile(state)
  pendingStructuredLaunchesByWorktree.set(worktreeId, state)
  notifyStructuredLaunchListeners()
  trackLaunchSettlement(worktreeId, state, state.promise)
  return state.promise
}

/** Stop retries for a launch whose tab the user explicitly closed. */
export function cancelStructuredCodexLaunch(worktreeId: string, sessionId: string): boolean {
  const state = pendingStructuredLaunchesByWorktree.get(worktreeId)
  if (!state || state.intent.sessionId !== sessionId) {
    return false
  }
  state.cancelled = true
  pendingStructuredLaunchesByWorktree.delete(worktreeId)
  notifyStructuredLaunchListeners()
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  return true
}

export function startStructuredCodexLaunch(worktreeId: string): void {
  void launchStructuredCodexSessionOnce(worktreeId).catch((error) => {
    if (error instanceof StructuredAgentSessionLaunchCancelledError) {
      return
    }
    toast.error(
      translate(
        'components.native-chat.structuredSessionLaunchFailed',
        'Could not open Codex chat'
      ),
      { description: error instanceof Error ? error.message : String(error) }
    )
  })
}
