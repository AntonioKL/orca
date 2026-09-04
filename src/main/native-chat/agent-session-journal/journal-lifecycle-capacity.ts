import type {
  AgentJournalItemBody,
  AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'
import { journalTxnPhysicalCost } from './journal-database-space'

export type JournalLifecycleReservation = {
  id: string
  bytes: number
  appendSlots: number
}

// Logical budgets. Every use site converts them through `journalTxnPhysicalCost`
// so a token covers the PAGE cost of the row it was granted for.
export const JOURNAL_TURN_TERMINAL_RESERVATION_BYTES = 128 * 1024
export const JOURNAL_ITEM_TERMINAL_RESERVATION_BYTES = 64 * 1024
export const JOURNAL_DISPATCH_RESERVATION_BYTES = 32 * 1024

export function journalReservationPhysicalBytes(logicalBytes: number, pageSize: number): number {
  return journalTxnPhysicalCost([logicalBytes], pageSize)
}

export class JournalLifecycleCapacity {
  private readonly reservations = new Map<string, JournalLifecycleReservation>()

  get reservedBytes(): number {
    return [...this.reservations.values()].reduce((total, token) => total + token.bytes, 0)
  }

  get reservedAppendSlots(): number {
    return [...this.reservations.values()].reduce((total, token) => total + token.appendSlots, 0)
  }

  has(id: string): boolean {
    return this.reservations.has(id)
  }

  token(id: string): JournalLifecycleReservation | null {
    return this.reservations.get(id) ?? null
  }

  clone(): JournalLifecycleCapacity {
    const copy = new JournalLifecycleCapacity()
    for (const token of this.reservations.values()) {
      copy.reservations.set(token.id, { ...token })
    }
    return copy
  }

  replaceFrom(source: JournalLifecycleCapacity): void {
    this.reservations.clear()
    for (const token of source.reservations.values()) {
      this.reservations.set(token.id, { ...token })
    }
  }

  reserve(
    token: JournalLifecycleReservation,
    currentPhysicalBytes: number,
    maxBytes: number,
    maxAppendSlots = Number.MAX_SAFE_INTEGER
  ): boolean {
    if (this.reservations.has(token.id)) {
      return true
    }
    if (currentPhysicalBytes + this.reservedBytes + token.bytes > maxBytes) {
      return false
    }
    if (this.reservedAppendSlots + token.appendSlots > maxAppendSlots) {
      return false
    }
    this.reservations.set(token.id, token)
    return true
  }

  transfer(fromId: string, toId: string): boolean {
    const existing = this.reservations.get(fromId)
    if (!existing) {
      return false
    }
    this.reservations.delete(fromId)
    this.reservations.set(toId, { ...existing, id: toId })
    return true
  }

  claimFirst(prefix: string, toId: string): boolean {
    const fromId = [...this.reservations.keys()].find((id) => id.startsWith(prefix))
    return fromId ? this.transfer(fromId, toId) : false
  }

  release(id: string): void {
    this.reservations.delete(id)
  }

  covers(ids: readonly string[], bytes: number, appendSlots: number): boolean {
    const tokens = ids.flatMap((id) => {
      const token = this.reservations.get(id)
      return token ? [token] : []
    })
    return (
      tokens.length > 0 &&
      tokens.reduce((total, token) => total + token.bytes, 0) >= bytes &&
      tokens.reduce((total, token) => total + token.appendSlots, 0) >= appendSlots
    )
  }

  rebuild(
    snapshot: AgentJournalSnapshot,
    maxBytes: number,
    currentPhysicalBytes: number,
    maxAppendSlots = Number.MAX_SAFE_INTEGER,
    pageSize = 4096
  ): boolean {
    this.reservations.clear()
    for (const item of snapshot.items) {
      if (!requiresTerminalSettlement(item.body)) {
        continue
      }
      if (
        !this.reserve(
          {
            id: lifecycleReservationIdForItem(item.itemId),
            bytes: terminalReservationBytes(item.body, pageSize),
            appendSlots: 1
          },
          currentPhysicalBytes,
          maxBytes,
          maxAppendSlots
        )
      ) {
        return false
      }
    }
    for (const submission of snapshot.submissions) {
      if (submission.dispatchState !== 'pending' && submission.dispatchState !== 'unknown') {
        continue
      }
      // A write-ahead submission owns both its dispatch attempt and the
      // terminal turn settlement. Rebuild both reservations after restart;
      // restoring only the tentative turn token would let a new send consume
      // the dispatch headroom still owed to this unresolved submission.
      if (
        !this.reserve(
          {
            id: dispatchReservationId(submission.clientMessageId),
            bytes: journalReservationPhysicalBytes(JOURNAL_DISPATCH_RESERVATION_BYTES, pageSize),
            appendSlots: 1
          },
          currentPhysicalBytes,
          maxBytes,
          maxAppendSlots
        )
      ) {
        return false
      }
      if (
        !this.reserve(
          {
            id: tentativeTurnReservationId(submission.clientMessageId),
            bytes: journalReservationPhysicalBytes(
              JOURNAL_TURN_TERMINAL_RESERVATION_BYTES,
              pageSize
            ),
            appendSlots: 1
          },
          currentPhysicalBytes,
          maxBytes,
          maxAppendSlots
        )
      ) {
        return false
      }
    }
    return true
  }
}

export function lifecycleReservationIdForItem(itemId: string): string {
  return `item:${itemId}`
}

export function dispatchReservationId(clientMessageId: string): string {
  return `dispatch:${clientMessageId}`
}

export function tentativeTurnReservationId(clientMessageId: string): string {
  return `tentative-turn:${clientMessageId}`
}

export function requiresTerminalSettlement(body: AgentJournalItemBody): boolean {
  if (body.kind === 'tool-call') {
    return body.state === 'running'
  }
  if (body.kind === 'approval' || body.kind === 'question') {
    return body.resolution.state === 'pending'
  }
  return body.kind === 'status' && body.turnLifecycle?.state === 'running'
}

export function terminalReservationBytes(body: AgentJournalItemBody, pageSize = 4096): number {
  return journalReservationPhysicalBytes(
    body.kind === 'status' && body.turnLifecycle?.state === 'running'
      ? JOURNAL_TURN_TERMINAL_RESERVATION_BYTES
      : JOURNAL_ITEM_TERMINAL_RESERVATION_BYTES,
    pageSize
  )
}
