import { isCursorAgentTitle } from '../../../shared/agent-detection'
import { formatMessagePointer } from './formatter'
import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import {
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'
import type { OrchestrationMailboxPointerMessage } from './mailbox-pointer-batch'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'
import { submitOrchestrationMailboxPointer } from './mailbox-pointer-submit'
import type { OrchestrationMailboxPointerSubmitTarget } from './mailbox-pointer-submit'

type StagePointerArgs<TWaiter extends OrchestrationMessageWaiter> = {
  deps: PointerDeliveryDependencies<TWaiter>
  state: OrchestrationMailboxPointerState
  leaf: OrchestrationMailboxLeaf
  mailboxHandle: string
  messages: readonly OrchestrationMailboxPointerMessage[]
  newestSequence: number
  enterDelayMs: number
  leafKey: string
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}

export function stageOrchestrationMailboxPointer<TWaiter extends OrchestrationMessageWaiter>(
  args: StagePointerArgs<TWaiter>
): void {
  const ptyId = args.leaf.ptyId
  if (!ptyId) {
    return
  }
  const expectedTarget = args.deps.resolveSubmitTarget(args.leaf, ptyId)
  if (!expectedTarget) {
    return
  }
  const db = args.deps.getDb()
  const reservationTarget = {
    ptyId,
    processIncarnation: expectedTarget.processIncarnation
  }
  if (
    !db ||
    shouldReleaseOrchestrationPointer(
      db,
      args.mailboxHandle,
      args.messages,
      args.deps.getMessageWaiters(args.mailboxHandle)
    )
  ) {
    return
  }
  const flight = args.state.beginFlight(ptyId)
  flight.stagedMessageIds = args.messages.map((message) => message.id)
  args.state.setWatermark(args.mailboxHandle, args.newestSequence, ptyId, args.leafKey)
  try {
    if (
      !db.stageMailboxPointerEnter(flight.stagedMessageIds, reservationTarget) ||
      !db.markMailboxPointerWriteAttempted(flight.stagedMessageIds, reservationTarget)
    ) {
      db.markAsUndelivered(flight.stagedMessageIds)
      args.settle(ptyId, flight)
      args.redrive(args.mailboxHandle, true)
      return
    }
  } catch {
    // The reservation may already be durable; recovery decides whether redrive is safe.
    args.settle(ptyId, flight)
    return
  }
  const finishPointerWrite = (accepted: boolean): void =>
    finishPointerWriteAndStageEnter(args, ptyId, flight, expectedTarget, accepted)
  try {
    const writeResult = args.deps.writePty(
      ptyId,
      formatMessagePointer(
        args.messages.length,
        args.mailboxHandle,
        args.deps.getCliCommand(expectedTarget.terminalHandle)
      )
    )
    if (typeof writeResult === 'boolean') {
      finishPointerWrite(writeResult)
      return
    }
    void writeResult
      .then(finishPointerWrite, () => finishPointerWrite(false))
      .catch(() => undefined)
  } catch {
    finishPointerWrite(false)
  }
}

function finishPointerWriteAndStageEnter<TWaiter extends OrchestrationMessageWaiter>(
  args: StagePointerArgs<TWaiter>,
  ptyId: string,
  flight: OrchestrationMailboxDeliveryFlight,
  expectedTarget: OrchestrationMailboxPointerSubmitTarget,
  accepted: boolean
): void {
  let delayedSettle = false
  try {
    if (!args.state.isCurrentFlight(ptyId, flight)) {
      return
    }
    const db = args.deps.getDb()
    if (!accepted) {
      db?.markAsUndelivered(flight.stagedMessageIds)
      args.state.clearWatermark(args.mailboxHandle, args.newestSequence, ptyId)
      return
    }
    if (
      !db ||
      shouldReleaseOrchestrationPointer(
        db,
        args.mailboxHandle,
        args.messages,
        args.deps.getMessageWaiters(args.mailboxHandle)
      )
    ) {
      if (args.state.clearWatermark(args.mailboxHandle, args.newestSequence, ptyId)) {
        args.redrive(args.mailboxHandle)
      }
      return
    }
    if (
      [args.leaf.lastOscTitle, args.leaf.paneTitle, args.deps.getTabTitle(args.leaf.tabId)].some(
        isCursorAgentTitle
      )
    ) {
      db.markAsDelivered(flight.stagedMessageIds)
      args.state.clearWatermark(args.mailboxHandle, args.newestSequence, ptyId)
      args.redrive(args.mailboxHandle)
      return
    }
    const submitEnter = (): void =>
      submitOrchestrationMailboxPointer(
        {
          mailboxOwner: args.deps.mailboxOwner,
          state: args.state,
          getDb: args.deps.getDb,
          resolveSubmitTarget: args.deps.resolveSubmitTarget,
          getMessageWaiters: args.deps.getMessageWaiters,
          isLeafPtyProvenAbsent: args.deps.isLeafPtyProvenAbsent,
          writePty: args.deps.writePty,
          settle: args.settle,
          redrive: args.redrive
        },
        {
          leaf: args.leaf,
          mailboxHandle: args.mailboxHandle,
          messages: args.messages,
          newestSequence: args.newestSequence,
          ptyId,
          flight,
          expectedTarget
        }
      )
    flight.submitEnter = submitEnter
    const deferredEnter = flight.idleObservedWhileDeferred
      ? args.state.takeDeferredEnter(ptyId)
      : null
    if (!deferredEnter && !flight.deferredUntilIdle) {
      flight.enterTimer = setTimeout(() => {
        flight.enterTimer = null
        flight.submitEnter = null
        submitEnter()
      }, args.enterDelayMs)
    }
    delayedSettle = true
    deferredEnter?.()
  } finally {
    if (!delayedSettle) {
      args.settle(ptyId, flight)
    }
  }
}
