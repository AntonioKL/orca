import { ORCHESTRATION_DELIVERY_BATCH_LIMIT, type OrchestrationDb } from './db'
import {
  messageTypeHasOrchestrationWaiter,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'

export type OrchestrationMailboxPointerMessage = {
  id: string
  type: string
  sequence: number
  pointer_enter_pending?: number
  pointer_pty_id?: string | null
  pointer_process_incarnation?: string | null
}

export function selectOrchestrationMailboxPointerBatch<
  TWaiter extends OrchestrationMessageWaiter
>(params: {
  db: OrchestrationDb
  mailboxHandle: string
  reservedTypes?: ReadonlySet<string>
  waiters: ReadonlySet<TWaiter> | undefined
}): OrchestrationMailboxPointerMessage[] {
  const excludedTypes = new Set(params.reservedTypes)
  for (const waiter of params.waiters ?? []) {
    for (const type of waiter.typeFilter ?? []) {
      excludedTypes.add(type)
    }
  }
  return params.db
    .getUndeliveredUnreadMessages(params.mailboxHandle, undefined, {
      excludeTypes: [...excludedTypes],
      limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT
    })
    .filter(
      (message) =>
        !params.reservedTypes?.has(message.type) &&
        !messageTypeHasOrchestrationWaiter(params.waiters, message.type)
    )
    .slice(0, ORCHESTRATION_DELIVERY_BATCH_LIMIT)
}
