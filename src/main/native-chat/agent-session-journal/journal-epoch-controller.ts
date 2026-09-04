import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { replaceJournalEpoch, type JournalReplacementItem } from './journal-epoch-replacement'
import { publishNewEpoch } from './journal-epoch-rollover'
import type { JournalLoad } from './journal-open'
import type { AgentJournalEpochReason } from './journal-row-schema'
import {
  assertJournalFence,
  assertJournalWritable,
  type JournalAppendBudget
} from './journal-write-guards'

export class JournalEpochController {
  constructor(
    private readonly deps: {
      identity: AgentSessionJournalIdentity
      journalDir: string
      dbPath: string
      budget: JournalAppendBudget
      now: () => number
      mintEpoch: () => string
      serialize: <T>(run: () => Promise<T>) => Promise<T>
      database: () => { db: Database.Database; pageSize: number }
      readOnly: () => boolean
      setReadOnly: (readOnly: boolean) => void
      highestFence: () => number
      cursor: () => AgentJournalCursor
      adopt: (loaded: JournalLoad) => void
    }
  ) {}

  async start(reason: AgentJournalEpochReason, fence: number): Promise<void> {
    const { db, pageSize } = this.deps.database()
    this.deps.adopt(
      await publishNewEpoch({
        db,
        pageSize,
        journalDir: this.deps.journalDir,
        dbPath: this.deps.dbPath,
        sessionId: this.deps.identity.sessionId,
        providerHandle: this.deps.identity.providerHandle,
        epoch: this.deps.mintEpoch(),
        reason,
        fence,
        now: this.deps.now(),
        maxSessionBytes: this.deps.budget.maxSessionBytes
      })
    )
  }

  /**
   * Every reason takes the same writable guard. A latched store refuses a roll
   * like any other write: with the byte-copy quarantine gone there is nothing
   * for `schema_unreadable` to do differently, and it has no production caller.
   *
   * Serialized like every other write, so the discard cannot land between an
   * admitted append's sequence assignment and its commit.
   */
  roll(reason: AgentJournalEpochReason, fence: number): Promise<AgentJournalCursor> {
    return this.deps.serialize(async () => {
      assertJournalWritable(this.deps.readOnly(), this.deps.identity.sessionId)
      await this.start(reason, fence)
      this.deps.setReadOnly(false)
      return this.deps.cursor()
    })
  }

  replace(
    reason: AgentJournalEpochReason,
    fence: number,
    items: readonly JournalReplacementItem[]
  ): Promise<AgentJournalCursor> {
    return this.deps.serialize(async () => {
      assertJournalWritable(this.deps.readOnly(), this.deps.identity.sessionId)
      assertJournalFence(fence, this.deps.highestFence())
      const { db, pageSize } = this.deps.database()
      await replaceJournalEpoch({
        db,
        pageSize,
        journalDir: this.deps.journalDir,
        dbPath: this.deps.dbPath,
        identity: this.deps.identity,
        reason,
        fence,
        items,
        budget: this.deps.budget.fork(),
        now: this.deps.now,
        mintEpoch: this.deps.mintEpoch,
        onPublished: this.deps.adopt
      })
      return this.deps.cursor()
    })
  }
}
