import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxLeaf } from './mailbox-owner'
import type { OrchestrationMailboxPointerMessage } from './mailbox-pointer-batch'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_RESERVED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from './db/messages/mailbox-pointer-enter-state'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'

export function resumePendingOrchestrationMailboxPointer<
  TWaiter extends OrchestrationMessageWaiter
>(args: {
  deps: PointerDeliveryDependencies<TWaiter>
  state: OrchestrationMailboxPointerState
  leaf: OrchestrationMailboxLeaf
  mailboxHandle: string
  messages: readonly OrchestrationMailboxPointerMessage[]
  enterDelayMs: number
  leafKey: string
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}): boolean {
  const ptyId = args.leaf.ptyId
  const newestSequence = args.messages.at(-1)?.sequence
  const expectedTarget = ptyId ? args.deps.resolveSubmitTarget(args.leaf, ptyId) : null
  const staged = args.messages[0]
  const messageIds = args.messages.map((message) => message.id)
  const phases = new Set(args.messages.map((message) => message.pointer_enter_pending))
  const persistedTarget = staged?.pointer_pty_id
    ? {
        ptyId: staged.pointer_pty_id,
        processIncarnation: staged.pointer_process_incarnation ?? ''
      }
    : null
  if (
    !ptyId ||
    newestSequence === undefined ||
    !expectedTarget ||
    !staged ||
    staged.pointer_pty_id !== ptyId ||
    staged.pointer_process_incarnation !== expectedTarget.processIncarnation ||
    args.messages.some(
      (message) =>
        message.pointer_pty_id !== staged.pointer_pty_id ||
        message.pointer_process_incarnation !== staged.pointer_process_incarnation
    )
  ) {
    if (persistedTarget) {
      args.deps
        .getDb()
        ?.releaseMailboxPointerEnter(messageIds, persistedTarget, [
          MAILBOX_POINTER_RESERVED,
          MAILBOX_POINTER_WRITE_ATTEMPTED,
          MAILBOX_POINTER_ENTER_ATTEMPTED
        ])
    }
    return false
  }
  if (phases.size !== 1 || !phases.has(MAILBOX_POINTER_RESERVED)) {
    // Same-incarnation recovery cannot tell whether pointer text or Enter reached the PTY.
    args.deps
      .getDb()
      ?.settleMailboxPointerEnter(messageIds, persistedTarget!, [
        MAILBOX_POINTER_WRITE_ATTEMPTED,
        MAILBOX_POINTER_ENTER_ATTEMPTED
      ])
    return true
  }
  args.deps
    .getDb()
    ?.releaseMailboxPointerEnter(messageIds, persistedTarget!, [MAILBOX_POINTER_RESERVED])
  return false
}
