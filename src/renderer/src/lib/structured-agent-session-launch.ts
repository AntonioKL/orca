import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  abandonStructuredAgentSessionLaunchIntent,
  createStructuredCodexSessionLaunchIntent,
  StructuredAgentSessionCreateRefusalError
} from '@/lib/launch-structured-codex-session'
import {
  discardStructuredAgentSessionLaunchOutbox,
  enqueueStructuredAgentSessionLaunchPrompt
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import {
  launchAndReconcile,
  reconcileUnknownLaunch,
  StructuredAgentSessionLaunchCancelledError,
  type StructuredCodexLaunchReceipt,
  type StructuredLaunchRecoveryState
} from '@/lib/structured-agent-session-launch-recovery'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import {
  addStructuredLaunchCaller,
  claimStructuredLaunchCallerFallback,
  createStructuredLaunchCallerGroup,
  settleStructuredLaunchCallersWithFallback,
  settleStructuredLaunchCallersWithoutFallback,
  structuredLaunchCallersHavePendingWork,
  type StructuredCodexLaunchOptions,
  type StructuredLaunchCaller,
  type StructuredLaunchCallerGroup,
  type StructuredRefusalFallback
} from '@/lib/structured-agent-session-launch-callers'

export type { StructuredCodexLaunchOptions, StructuredCodexLaunchReceipt }

type StructuredLaunchState = StructuredLaunchRecoveryState & {
  identity: string
  callers: StructuredLaunchCallerGroup
}

type StructuredLaunchStateResult = {
  state: StructuredLaunchState
  caller: StructuredLaunchCaller
}

export type StructuredCodexLaunchResult = {
  sessionId: string
  launchResult: Promise<StructuredCodexLaunchReceipt>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  isVisibilityUnknown: () => boolean
  claimDefinitiveRefusalFallback: (fallback: StructuredRefusalFallback) => Promise<boolean>
}

const pendingStructuredLaunchesByIdentity = new Map<string, StructuredLaunchState>()

function launchIdentity(worktreeId: string): string {
  return worktreeId
}

function cleanupLaunchState(state: StructuredLaunchState): void {
  if (pendingStructuredLaunchesByIdentity.get(state.identity) === state) {
    pendingStructuredLaunchesByIdentity.delete(state.identity)
  }
}

function maybeCleanupLaunchState(state: StructuredLaunchState): void {
  if (structuredLaunchCallersHavePendingWork(state.callers)) {
    return
  }
  cleanupLaunchState(state)
}

function settleDefinitiveRefusalFallback(state: StructuredLaunchState): void {
  if (state.callers.outcome === 'refused') {
    return
  }
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  discardStructuredAgentSessionLaunchOutbox(state.intent.sessionId)
  settleStructuredLaunchCallersWithFallback(state.callers)
}

function trackLaunchSettlement(
  state: StructuredLaunchState,
  promise: Promise<StructuredCodexLaunchReceipt>
): void {
  void promise.then(
    () => {
      if (state.promise !== promise) {
        return
      }
      settleStructuredLaunchCallersWithoutFallback(state.callers, 'published')
      maybeCleanupLaunchState(state)
    },
    (error) => {
      if (state.promise !== promise || state.cancelled) {
        return
      }
      if (error instanceof StructuredAgentSessionCreateRefusalError) {
        settleDefinitiveRefusalFallback(state)
      } else if (!state.visibilityUnknown) {
        settleStructuredLaunchCallersWithoutFallback(state.callers, 'failed')
        maybeCleanupLaunchState(state)
      } else {
        state.callers.outcome = 'unknown'
      }
    }
  )
}

function trackLaunchFailureToast(state: StructuredLaunchState): void {
  void state.promise.catch(async (error) => {
    if (error instanceof StructuredAgentSessionLaunchCancelledError) {
      return
    }
    if (
      error instanceof StructuredAgentSessionCreateRefusalError &&
      (await state.callers.refusalSettlement.promise.catch(() => false))
    ) {
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

function structuredCodexLaunchState(
  worktreeId: string,
  options: StructuredCodexLaunchOptions
): StructuredLaunchStateResult {
  const identity = launchIdentity(worktreeId)
  const existing = pendingStructuredLaunchesByIdentity.get(identity)
  if (existing) {
    if (existing.visibilityUnknown) {
      existing.callers.outcome = 'pending'
      existing.promise = reconcileUnknownLaunch(existing)
      trackLaunchSettlement(existing, existing.promise)
      trackLaunchFailureToast(existing)
    }
    const text = options.prompt?.trim() ?? ''
    const stagedPrompt =
      text && existing.callers.outcome !== 'refused'
        ? enqueueStructuredAgentSessionLaunchPrompt(existing.intent.sessionId, text)
        : null
    return {
      state: existing,
      caller: addStructuredLaunchCaller({
        group: existing.callers,
        launchResult: existing.promise,
        options,
        stagedEntry: stagedPrompt
      })
    }
  }

  const intent = createStructuredCodexSessionLaunchIntent(worktreeId)
  const text = options.prompt?.trim() ?? ''
  const stagedPrompt = text
    ? enqueueStructuredAgentSessionLaunchPrompt(intent.sessionId, text)
    : null
  const callers = createStructuredLaunchCallerGroup()
  const state: StructuredLaunchState = {
    identity,
    intent,
    promise: Promise.resolve({ sessionId: '', fence: 0 }),
    visibilityUnknown: false,
    cancelled: false,
    callers
  }
  callers.onSettled = () => maybeCleanupLaunchState(state)
  state.promise =
    text && !stagedPrompt
      ? Promise.reject(
          new StructuredAgentSessionCreateRefusalError(
            'Could not durably stage the Codex launch prompt.'
          )
        )
      : launchAndReconcile(state)
  const caller = addStructuredLaunchCaller({
    group: state.callers,
    launchResult: state.promise,
    options,
    stagedEntry: stagedPrompt
  })
  pendingStructuredLaunchesByIdentity.set(identity, state)
  trackLaunchSettlement(state, state.promise)
  trackLaunchFailureToast(state)
  return {
    state,
    caller
  }
}

export function cancelStructuredCodexLaunch(worktreeId: string, sessionId: string): boolean {
  const state = [...pendingStructuredLaunchesByIdentity.values()].find(
    (candidate) =>
      candidate.intent.worktreeId === worktreeId && candidate.intent.sessionId === sessionId
  )
  if (!state) {
    return false
  }
  state.cancelled = true
  settleStructuredLaunchCallersWithoutFallback(state.callers, 'cancelled')
  cleanupLaunchState(state)
  discardStructuredAgentSessionLaunchOutbox(state.intent.sessionId)
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  return true
}

export function startStructuredCodexLaunch(
  worktreeId: string,
  options: StructuredCodexLaunchOptions = {}
): StructuredCodexLaunchResult {
  const { state, caller } = structuredCodexLaunchState(worktreeId, options)
  return {
    sessionId: state.intent.sessionId,
    launchResult: state.promise,
    ...(caller.promptDeliveryResult ? { promptDeliveryResult: caller.promptDeliveryResult } : {}),
    isVisibilityUnknown: () => state.visibilityUnknown,
    claimDefinitiveRefusalFallback: (fallback) =>
      claimStructuredLaunchCallerFallback(state.callers, caller, fallback)
  }
}
