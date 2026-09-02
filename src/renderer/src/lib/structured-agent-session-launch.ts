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
import {
  settleStructuredCodexLaunchPrompt,
  type StructuredPromptDeliveryResult
} from '@/lib/structured-agent-session-launch-prompt'

export type { StructuredCodexLaunchReceipt }

type StructuredRefusalFallback = () =>
  | void
  | StructuredPromptDeliveryResult
  | Promise<void | StructuredPromptDeliveryResult>

type StructuredLaunchState = StructuredLaunchRecoveryState & {
  identity: string
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  refusalFallback: {
    callback: StructuredRefusalFallback | null
    promise: Promise<boolean>
    resolve: (ran: boolean) => void
    reject: (error: unknown) => void
    promptDeliveryPromise: Promise<StructuredPromptDeliveryResult | null>
    resolvePromptDelivery: (result: StructuredPromptDeliveryResult | null) => void
    started: boolean
  }
}

type StructuredLaunchStateResult = {
  state: StructuredLaunchState
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
}

export type StructuredCodexLaunchOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready'
  onPromptDelivered?: () => void
}

export type StructuredCodexLaunchResult = {
  sessionId: string
  launchResult: Promise<StructuredCodexLaunchReceipt>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
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

function settleDefinitiveRefusalFallback(state: StructuredLaunchState): void {
  if (state.refusalFallback.started) {
    return
  }
  state.refusalFallback.started = true
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  discardStructuredAgentSessionLaunchOutbox(state.intent.sessionId)
  const fallback = state.refusalFallback.callback
  if (!fallback) {
    state.refusalFallback.resolve(false)
    state.refusalFallback.resolvePromptDelivery(null)
    cleanupLaunchState(state)
    return
  }
  void Promise.resolve()
    .then(fallback)
    .then(
      (result) => {
        state.refusalFallback.resolve(true)
        state.refusalFallback.resolvePromptDelivery(result ?? null)
      },
      (error) => {
        state.refusalFallback.reject(error)
        state.refusalFallback.resolvePromptDelivery(null)
      }
    )
    .finally(() => cleanupLaunchState(state))
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
      state.refusalFallback.resolve(false)
      if (state.promptDeliveryResult) {
        void state.promptDeliveryResult.finally(() => cleanupLaunchState(state))
      } else {
        cleanupLaunchState(state)
      }
    },
    (error) => {
      if (state.promise !== promise || state.cancelled) {
        return
      }
      if (error instanceof StructuredAgentSessionCreateRefusalError) {
        settleDefinitiveRefusalFallback(state)
      } else if (!state.visibilityUnknown) {
        state.refusalFallback.resolve(false)
        cleanupLaunchState(state)
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
      (await state.refusalFallback.promise.catch(() => false))
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
      existing.promise = reconcileUnknownLaunch(existing)
      trackLaunchSettlement(existing, existing.promise)
      trackLaunchFailureToast(existing)
    }
    const text = options.prompt?.trim() ?? ''
    const stagedPrompt = text
      ? enqueueStructuredAgentSessionLaunchPrompt(existing.intent.sessionId, text)
      : null
    const promptDeliveryResult = settleStructuredCodexLaunchPrompt({
      launchResult: existing.promise,
      options,
      stagedEntry: stagedPrompt
    })
    const recoveredPromptDeliveryResult = promptDeliveryResult?.catch(async (error) => {
      if (error instanceof StructuredAgentSessionCreateRefusalError) {
        return (
          (await existing.refusalFallback.promptDeliveryPromise) ?? {
            delivered: false,
            failureNotified: true
          }
        )
      }
      return { delivered: false, failureNotified: true }
    })
    return {
      state: existing,
      ...(recoveredPromptDeliveryResult
        ? { promptDeliveryResult: recoveredPromptDeliveryResult }
        : {})
    }
  }

  const fallback = Promise.withResolvers<boolean>()
  const fallbackPromptDelivery = Promise.withResolvers<StructuredPromptDeliveryResult | null>()
  const intent = createStructuredCodexSessionLaunchIntent(worktreeId)
  const text = options.prompt?.trim() ?? ''
  const stagedPrompt = text
    ? enqueueStructuredAgentSessionLaunchPrompt(intent.sessionId, text)
    : null
  const state: StructuredLaunchState = {
    identity,
    intent,
    promise: Promise.resolve({ sessionId: '', fence: 0 }),
    visibilityUnknown: false,
    cancelled: false,
    refusalFallback: {
      callback: null,
      promise: fallback.promise,
      resolve: fallback.resolve,
      reject: fallback.reject,
      promptDeliveryPromise: fallbackPromptDelivery.promise,
      resolvePromptDelivery: fallbackPromptDelivery.resolve,
      started: false
    }
  }
  state.promise =
    text && !stagedPrompt
      ? Promise.reject(
          new StructuredAgentSessionCreateRefusalError(
            'Could not durably stage the Codex launch prompt.'
          )
        )
      : launchAndReconcile(state)
  const promptDeliveryResult = settleStructuredCodexLaunchPrompt({
    launchResult: state.promise,
    options,
    stagedEntry: stagedPrompt
  })
  state.promptDeliveryResult = promptDeliveryResult?.catch(async (error) => {
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      return (
        (await state.refusalFallback.promptDeliveryPromise) ?? {
          delivered: false,
          failureNotified: true
        }
      )
    }
    return { delivered: false, failureNotified: true }
  })
  pendingStructuredLaunchesByIdentity.set(identity, state)
  trackLaunchSettlement(state, state.promise)
  trackLaunchFailureToast(state)
  return {
    state,
    ...(state.promptDeliveryResult ? { promptDeliveryResult: state.promptDeliveryResult } : {})
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
  cleanupLaunchState(state)
  discardStructuredAgentSessionLaunchOutbox(state.intent.sessionId)
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  return true
}

export function startStructuredCodexLaunch(
  worktreeId: string,
  options: StructuredCodexLaunchOptions = {}
): StructuredCodexLaunchResult {
  const { state, promptDeliveryResult } = structuredCodexLaunchState(worktreeId, options)
  return {
    sessionId: state.intent.sessionId,
    launchResult: state.promise,
    ...(promptDeliveryResult ? { promptDeliveryResult } : {}),
    claimDefinitiveRefusalFallback: (fallback) => {
      state.refusalFallback.callback ??= fallback
      return state.refusalFallback.promise
    }
  }
}
