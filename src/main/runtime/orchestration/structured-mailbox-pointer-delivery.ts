/**
 * The pointer-delivery lane for workers that ARE a structured agent session.
 *
 * The PTY lane types the nudge into a live pane and reads the idle edge off the terminal title.
 * Neither exists here, so this is a sibling of `OrchestrationMailboxPointerDelivery` rather than a
 * branch inside it: batch selection is literally shared (`selectOrchestrationPointerBatch`), and
 * everything below it is different — the nudge is a session turn, the idle edge is the journal,
 * and only an `accepted` dispatch may consume mail.
 *
 * Coordinators are deliberately out of scope: `run:` mail routes through a coordinator handle, and
 * a coordinator blocks in `check --wait`, where a waiter preempts pointer delivery anyway.
 */

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { OrchestrationDb } from './db'
import { formatMessagePointer } from './formatter'
import {
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import { resolveStructuredPointerOperation } from './structured-pointer-operation-id'
import {
  decideStructuredPointerDelivery,
  decideStructuredSessionPointerDelivery,
  retainReasonForDispatch,
  retainWaitsForJournalEdge,
  structuredDispatchDelivered,
  type StructuredDispatchState,
  type StructuredPointerRetainReason,
  type StructuredSessionGateFacts
} from './structured-session-pointer-delivery'
import type { AgentSessionPtyWriteRefusal } from '../../../shared/agent-session-pty-write-admission'

export type StructuredPointerTarget = {
  sessionId: string
  dispatchId: string
  /** Present only for an adopted pane, where a PTY write was refused in favour of this owner. */
  refusal?: AgentSessionPtyWriteRefusal
}

export type StructuredPointerSendOutcome =
  | { kind: 'sent'; state: StructuredDispatchState }
  | { kind: 'unattached' }

export type StructuredMailboxPointerHost = {
  /** The idle gate, read off the session's full reduced timeline; `null` when it is not attached. */
  readGateFacts: (sessionId: string) => StructuredSessionGateFacts | null
  send: (input: {
    sessionId: string
    dispatchId: string
    operationId: string
    payloadFingerprint: string
    expectedRuntimeFence: number
    body: AgentJournalMessageItem
  }) => Promise<StructuredPointerSendOutcome>
  /** Current lease fence; `null` when no record backs the session any more. */
  currentFence: (sessionId: string) => number | null
}

type StructuredPointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  getDb: () => OrchestrationDb | null
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  /**
   * The session a mailbox must be nudged through, or null when a live PTY can take the bytes.
   *
   * Two shapes reach here. A NATIVE-BORN worker carries no refusal: it never had a PTY. An
   * ADOPTED one does — its pane is bound to a session a native owner holds, so the PTY write is
   * refused and the refusal is what proves the owner is settled enough to redirect to.
   */
  resolveStructuredTarget: (mailboxHandle: string) => StructuredPointerTarget | null
  host: StructuredMailboxPointerHost
  onRetain?: (input: {
    mailboxHandle: string
    sessionId: string
    reason: StructuredPointerRetainReason
  }) => void
}

export class OrchestrationStructuredMailboxPointerDelivery<
  TWaiter extends OrchestrationMessageWaiter
> {
  private readonly inFlight = new Set<string>()
  /** Mailboxes whose retry must wait for the session's next journal edge. */
  private readonly parkedUntilJournalEdge = new Map<string, ReadonlySet<string> | undefined>()

  constructor(private readonly deps: StructuredPointerDeliveryDependencies<TWaiter>) {}

  deliverForHandle(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): boolean {
    const target = this.deps.resolveStructuredTarget(mailboxHandle)
    if (!target) {
      return false
    }
    void this.deliver(mailboxHandle, target, reservedTypes).catch(() => {
      // Durable mail stays available to an explicit check or the next settle edge.
    })
    return true
  }

  /** The session's journal moved — a turn settled, or a re-attach replayed it; retry what is
   *  parked on that edge. */
  onJournalActivity(sessionId: string): void {
    for (const [mailboxHandle, reservedTypes] of Array.from(this.parkedUntilJournalEdge)) {
      const target = this.deps.resolveStructuredTarget(mailboxHandle)
      if (target?.sessionId !== sessionId) {
        continue
      }
      this.parkedUntilJournalEdge.delete(mailboxHandle)
      void this.deliver(mailboxHandle, target, reservedTypes).catch(() => undefined)
    }
  }

  /**
   * The worker settled; drop what it had parked.
   *
   * Also prunes entries whose target no longer resolves at all: after settlement the identity is
   * forgotten, so those can never be matched by session id again and would otherwise be immortal.
   */
  forgetSession(sessionId: string): void {
    for (const [mailboxHandle] of Array.from(this.parkedUntilJournalEdge)) {
      const target = this.deps.resolveStructuredTarget(mailboxHandle)
      if (!target || target.sessionId === sessionId) {
        this.parkedUntilJournalEdge.delete(mailboxHandle)
      }
    }
  }

  private async deliver(
    mailboxHandle: string,
    target: StructuredPointerTarget,
    reservedTypes?: ReadonlySet<string>
  ): Promise<void> {
    const db = this.deps.getDb()
    if (!db || this.inFlight.has(mailboxHandle)) {
      return
    }
    const runId = db.getDispatchContextById?.(target.dispatchId)?.run_id
    if (runId && db.hasOutstandingRunDelivery?.(runId)) {
      return
    }
    const unread = selectOrchestrationPointerBatch({
      db,
      mailboxHandle,
      waiters: this.deps.getMessageWaiters(mailboxHandle),
      reservedTypes
    })
    if (unread.length === 0) {
      return
    }
    this.inFlight.add(mailboxHandle)
    try {
      await this.attempt(db, mailboxHandle, target, unread, reservedTypes)
    } finally {
      this.inFlight.delete(mailboxHandle)
    }
  }

  private async attempt(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    unread: readonly { id: string; type: string; sequence: number }[],
    reservedTypes: ReadonlySet<string> | undefined
  ): Promise<void> {
    const sessionId = target.sessionId
    const session = this.deps.host.readGateFacts(sessionId)
    // Re-checked at send time, not just at resolve time: an adopted session's owner can change
    // between the two, and redirecting into a lease that is handing back to a TUI races it.
    const decision = target.refusal
      ? decideStructuredPointerDelivery({ session, refusal: target.refusal })
      : decideStructuredSessionPointerDelivery({ session })
    if (!decision.deliver) {
      this.retain(mailboxHandle, sessionId, decision.retain, reservedTypes)
      return
    }
    const fence = this.deps.host.currentFence(sessionId)
    if (fence === null) {
      this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
      return
    }
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: formatMessagePointer(unread.length, mailboxHandle).trim() }]
    }
    const operation = resolveStructuredPointerOperation({
      db,
      mailboxHandle,
      sessionId,
      body
    })
    const outcome = await this.deps.host.send({
      sessionId,
      dispatchId: target.dispatchId,
      operationId: operation.operationId,
      payloadFingerprint: operation.payloadFingerprint,
      expectedRuntimeFence: fence,
      body
    })
    if (outcome.kind === 'unattached') {
      this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
      return
    }
    if (!structuredDispatchDelivered(outcome.state)) {
      this.retain(
        mailboxHandle,
        sessionId,
        retainReasonForDispatch(outcome.state as Exclude<StructuredDispatchState, 'accepted'>),
        reservedTypes
      )
      return
    }
    const staged = unread.map((message) => message.id)
    db.markAsDelivered(staged)
    // The nudge landed as its own turn, so the next settle edge is the natural retry point for
    // anything that arrives while it runs.
    db.deleteStructuredPointerOperation(mailboxHandle)
  }

  /** No `markAsUndelivered` is owed: rows are marked delivered only after an accepted dispatch. */
  private retain(
    mailboxHandle: string,
    sessionId: string,
    reason: StructuredPointerRetainReason,
    reservedTypes: ReadonlySet<string> | undefined
  ): void {
    this.deps.onRetain?.({ mailboxHandle, sessionId, reason })
    if (retainWaitsForJournalEdge(reason)) {
      this.parkedUntilJournalEdge.set(mailboxHandle, reservedTypes)
    }
  }
}
