import type { MessageRow, MessageType } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'

export function hasQueuedMatchingRunMessages(
  this: OrchestrationDb,
  runId: string,
  deliveryMessages: MessageRow[],
  wakeTypes?: MessageType[]
): boolean {
  const lastSequence = deliveryMessages.at(-1)?.sequence
  if (lastSequence === undefined) {
    return false
  }
  const address = `run:${runId}`
  if (wakeTypes?.length) {
    const placeholders = wakeTypes.map(() => '?').join(',')
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM messages INDEXED BY idx_messages_unread_current_run_type
           WHERE run_id = ? AND to_handle = ? AND read = 0
             AND delivery_contract = 'current_delivery' AND sequence > ?
             AND type IN (${placeholders}) LIMIT 1`
        )
        .get(runId, address, lastSequence, ...wakeTypes)
    )
  }
  return Boolean(
    this.db
      .prepare(
        `SELECT 1 FROM messages INDEXED BY idx_messages_unread_current_inbox
         WHERE run_id = ? AND to_handle = ? AND read = 0
           AND delivery_contract = 'current_delivery' AND sequence > ? LIMIT 1`
      )
      .get(runId, address, lastSequence)
  )
}
