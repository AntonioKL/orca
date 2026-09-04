// Append-only journal store for one agent session.

import { randomUUID } from 'node:crypto'
import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalSnapshot,
  AgentJournalSubmission,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { openJournalDatabase, type OpenJournalDatabase } from './journal-database'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import { readJournalSince } from './journal-cursor'
import { readJournalRowsAfterCursor, replayJournal, type JournalLoad } from './journal-open'
import { journalDatabaseFile } from './journal-paths'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'
import { markJournalPendingSubmissionsUnknown } from './journal-pending-submission-recovery'
import { journalDirectoryBytes } from './journal-physical-quota'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState,
  resolveJournalItemId,
  type JournalReducerState
} from './journal-reducer'
import {
  journalDispatchRowBuilder,
  journalSubmissionRowBuilder,
  journalTombstoneRowBuilder
} from './journal-row-builders'
import type {
  AgentSessionJournalOptions,
  JournalAppendResult,
  JournalBlobInput,
  JournalItemAppendOptions,
  JournalLifecycleBatchInput,
  JournalReadSince,
  JournalSubmissionInput,
  JournalTombstoneInput,
  ResolveDispatchInput
} from './journal-store-contracts'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { AgentSessionJournalError, JournalAppendBudget } from './journal-write-guards'
import type { JournalLifecycleReservation } from './journal-lifecycle-capacity'
import type { JournalLifecycleAdmission } from './journal-lifecycle-admission'
import type { JournalRowWriter } from './journal-row-writer'
import type { JournalEpochController } from './journal-epoch-controller'
import { JournalConnectionCloser, JournalWriteQueue } from './journal-store-close'
import { createJournalStoreCollaborators } from './journal-store-collaborators'
import {
  assertJournalOpenCapacity,
  ensureJournalDir,
  journalStoreLoadedFields,
  openJournalStoreState,
  truncateJournalSuffix
} from './journal-store-open'
import type { JournalItemAppender } from './journal-item-appender'
import type { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'

export { AgentSessionJournalError } from './journal-write-guards'

export class AgentSessionJournal {
  private readonly identity: AgentSessionJournalIdentity
  private readonly journalDir: string
  private readonly dbPath: string
  private readonly budget: JournalAppendBudget
  private readonly now: () => number
  private readonly mintEpoch: () => string
  private readonly loaded: JournalLoad | null | undefined

  private state: JournalReducerState
  private sizeBytes = 0
  private readOnly = false
  private malformedRows = 0
  private database: OpenJournalDatabase | null = null
  private readonly queue: JournalWriteQueue
  private readonly closer: JournalConnectionCloser
  private readonly lifecycleAdmission: JournalLifecycleAdmission
  private readonly rowWriter: JournalRowWriter
  private readonly epochController: JournalEpochController
  private readonly itemAppender: JournalItemAppender
  private readonly lifecycleBatchAppender: JournalLifecycleBatchAppender

  constructor(options: AgentSessionJournalOptions) {
    this.identity = options.identity
    this.journalDir = options.journalDir
    this.dbPath = journalDatabaseFile(options.journalDir)
    this.budget = new JournalAppendBudget(
      options.identity.sessionId,
      options.limits ?? DEFAULT_JOURNAL_PAYLOAD_LIMITS
    )
    this.now = options.now ?? (() => Date.now())
    this.mintEpoch = options.mintEpoch ?? randomUUID
    this.loaded = options.loaded
    this.state = createJournalReducerState(options.identity.sessionId, '')
    // Serializes sequence assignment with the durable write behind it.
    this.queue = new JournalWriteQueue(options.identity.sessionId)
    this.closer = new JournalConnectionCloser({
      connection: () => this.database?.db ?? null,
      enqueue: (run) => this.queue.serializePastGate(run)
    })
    const collaborators = createJournalStoreCollaborators({
      identity: this.identity,
      journalDir: this.journalDir,
      dbPath: this.dbPath,
      budget: this.budget,
      now: this.now,
      mintEpoch: this.mintEpoch,
      serialize: (run) => this.queue.serialize(run),
      database: () => this.requireDatabase(),
      state: () => this.state,
      readOnly: () => this.readOnly,
      setReadOnly: (readOnly) => {
        this.readOnly = readOnly
      },
      cursor: this.cursor,
      adopt: (loaded) => this.adoptLoadedJournal(loaded),
      commit: (row, physicalBytes) => {
        applyJournalRow(this.state, row)
        this.sizeBytes = physicalBytes
      },
      journal: () => this,
      enqueue: (build, blobs) => this.enqueue(build, blobs)
    })
    this.lifecycleAdmission = collaborators.lifecycleAdmission
    this.rowWriter = collaborators.rowWriter
    this.epochController = collaborators.epochController
    this.itemAppender = collaborators.itemAppender
    this.lifecycleBatchAppender = collaborators.lifecycleBatchAppender
  }

  get isReadOnly(): boolean {
    return this.readOnly
  }

  get epoch(): string {
    return this.state.epoch
  }

  get directory(): string {
    return this.journalDir
  }

  async open(): Promise<void> {
    await ensureJournalDir(this.journalDir)
    await assertJournalOpenCapacity({
      journalDir: this.journalDir,
      sessionId: this.identity.sessionId,
      maxBytes: this.budget.maxSessionBytes
    })
    this.database = openJournalDatabase(this.dbPath)
    try {
      await openJournalStoreState({
        journalDir: this.journalDir,
        sessionId: this.identity.sessionId,
        loaded: this.loaded,
        replay: () => {
          const opened = this.requireDatabase()
          return replayJournal(opened.db, opened.readOnly, this.identity.sessionId)
        },
        truncateSuffix: (fromSeq) =>
          truncateJournalSuffix({
            db: this.requireDatabase().db,
            dbPath: this.dbPath,
            journalDir: this.journalDir,
            pageSize: this.requireDatabase().pageSize,
            sessionId: this.identity.sessionId,
            epoch: this.state.epoch,
            fromSeq,
            maxBytes: this.budget.maxSessionBytes
          }),
        start: () => this.epochController.start('session_created', 0),
        adopt: (loaded) => this.adoptLoadedJournal(loaded),
        snapshot: this.snapshot,
        rebuildLifecycle: (snapshot, bytes) => this.lifecycleAdmission.rebuild(snapshot, bytes),
        appendDisclosure: (identity, body, fence) => this.appendItem(identity, body, { fence }),
        highestFence: () => this.state.highestFence,
        malformedRows: () => this.malformedRows,
        readOnly: () => this.readOnly,
        setPhysicalBytes: (bytes) => {
          this.sizeBytes = bytes
        }
      })
    } catch (error) {
      // Nothing else holds a reference to this connection, so a throw here is
      // the leak site unless the store releases it itself.
      await this.close().catch(() => undefined)
      throw error
    }
  }

  /** Releases the session's SQLite handle. Idempotent on success, a real retry
   *  after a failure, and permanently closed to writes either way (§ close). */
  close(): Promise<void> {
    this.queue.markClosed()
    return this.closer.close()
  }

  cursor = (): AgentJournalCursor => ({
    epoch: this.state.epoch,
    sequence: this.state.lastSequence
  })

  snapshot = (): AgentJournalSnapshot => renderJournalState(this.state)

  submissions = (): AgentJournalSubmission[] => [...this.state.submissions.values()]

  pendingSubmissions = (): AgentJournalSubmission[] =>
    this.submissions().filter((entry) => entry.dispatchState === 'pending')

  /** The durable answer to "did my send land?" — a reconnecting client asking
   *  again gets this instead of re-sending. */
  receiptFor = (clientMessageId: string): AgentJournalAcceptanceReceipt | null =>
    this.state.receipts.get(clientMessageId) ?? null

  canonicalItemId = (itemId: string): string => resolveJournalItemId(this.state, itemId)

  reserveLifecycleCapacity(token: JournalLifecycleReservation): Promise<boolean> {
    return this.serializeCapacityMutation(async () => {
      this.sizeBytes = await journalDirectoryBytes(this.journalDir)
      return this.lifecycleAdmission.reserve(token, this.sizeBytes)
    })
  }

  transferLifecycleCapacity(fromId: string, toId: string): Promise<boolean> {
    return this.serializeCapacityMutation(() => this.lifecycleAdmission.transfer(fromId, toId))
  }

  releaseLifecycleCapacity(id: string): Promise<void> {
    return this.serializeCapacityMutation(() => this.lifecycleAdmission.release(id))
  }

  lifecycleCapacityState = (): { reservedBytes: number; reservedAppendSlots: number } =>
    this.lifecycleAdmission.state

  readSince(cursor: AgentJournalCursor): JournalReadSince {
    return readJournalSince(
      {
        state: this.state,
        rowsAfter: (afterSequence) =>
          readJournalRowsAfterCursor(
            this.requireDatabase().db,
            this.identity.sessionId,
            this.state.epoch,
            afterSequence
          ),
        readOnly: this.readOnly
      },
      cursor,
      () => this.cursor()
    )
  }

  /** Upsert by stable identity. The revision is assigned here so a caller
   *  cannot accidentally publish a revision the reducer will drop. */
  appendItem(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: JournalItemAppendOptions = { fence: 0 }
  ): Promise<JournalAppendResult> {
    return this.itemAppender.append(identity, body, options)
  }

  /** Blob-before-row admission on the same serialized path as sequence assignment. */
  appendItemWithBlobs(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    blobs: readonly JournalBlobInput[],
    options: JournalItemAppendOptions = { fence: 0 }
  ): Promise<JournalAppendResult> {
    return this.itemAppender.appendWithBlobs(identity, body, blobs, options)
  }

  appendTombstone(
    identity: AgentJournalItemIdentity,
    options: JournalTombstoneInput
  ): Promise<AgentJournalCursor> {
    const itemId = agentJournalItemKey(identity)
    return this.enqueue(journalTombstoneRowBuilder(() => this.state, itemId, options.fence)).then(
      (row) => ({ epoch: row.epoch, sequence: row.seq })
    )
  }

  appendLifecycleBatch(input: JournalLifecycleBatchInput): Promise<AgentJournalCursor> {
    return this.lifecycleBatchAppender.append(input)
  }

  /**
   * Write-ahead submission row. It is durable before the caller dispatches
   * anything, and it doubles as the optimistic user bubble so an accepted echo
   * reconciles into an existing slot instead of appending a second copy.
   */
  appendSubmission(input: JournalSubmissionInput): Promise<AgentJournalCursor> {
    return this.enqueue(
      journalSubmissionRowBuilder(() => this.state, this.identity.providerHandle, input)
    ).then((row) => ({ epoch: row.epoch, sequence: row.seq }))
  }

  /**
   * Advance a submission to exactly one of accepted / rejected / unknown.
   *
   * Accepting REQUIRES the provider identity rather than a free-form id: the
   * adopted key is what the provider's echo will upsert into, so a mismatched
   * string here would silently give the user a second copy of their own message.
   */
  resolveDispatch(input: ResolveDispatchInput): Promise<AgentJournalCursor> {
    return this.enqueue(journalDispatchRowBuilder(() => this.state, input)).then((row) => ({
      epoch: row.epoch,
      sequence: row.seq
    }))
  }

  /** On restart every `pending` submission becomes `unknown` before the session
   *  accepts a writer. Orca never re-sends on the user's behalf. */
  async markPendingSubmissionsUnknown(fence: number): Promise<string[]> {
    return markJournalPendingSubmissionsUnknown(this, fence)
  }

  /** The escape hatch for corruption, an unreconcilable prefix, a forked handle,
   *  and an unreadable schema. It invalidates every cursor; clients reload. */
  async rollEpoch(reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> {
    return this.epochController.roll(reason, fence)
  }

  replaceEpochItems(
    reason: AgentJournalEpochReason,
    fence: number,
    items: readonly JournalReplacementItem[]
  ): Promise<AgentJournalCursor> {
    return this.epochController.replace(reason, fence, items)
  }

  private adoptLoadedJournal(loaded: JournalLoad): void {
    Object.assign(this, journalStoreLoadedFields(loaded))
  }

  private requireDatabase(): OpenJournalDatabase {
    if (!this.database) {
      throw new AgentSessionJournalError(
        'journal_closed',
        `agent-session journal for ${this.identity.sessionId} is not open`
      )
    }
    return this.database
  }

  /**
   * Assign the next sequence, make the row durable, and fold it through the
   * SAME reducer replay uses — all inside one serialized step, so concurrent
   * callers cannot interleave and mint the same sequence.
   */
  private enqueue(
    build: (seq: number, ts: number) => JournalRow,
    blobs: readonly JournalBlobInput[] = []
  ): Promise<JournalRow> {
    return this.rowWriter.enqueue(build, blobs)
  }

  private serializeCapacityMutation = <T>(runMutation: () => Promise<T> | T): Promise<T> =>
    this.queue.serialize(async () => runMutation())
}
