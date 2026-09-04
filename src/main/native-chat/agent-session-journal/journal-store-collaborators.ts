// Wiring for the store's collaborators.
//
// Split out of the store itself so the class stays a description of the public
// surface rather than sixty lines of constructor plumbing.

import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { OpenJournalDatabase } from './journal-database'
import { JournalEpochController } from './journal-epoch-controller'
import { JournalItemAppender } from './journal-item-appender'
import { JournalLifecycleAdmission } from './journal-lifecycle-admission'
import { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import type { JournalLoad } from './journal-open'
import {
  referencedBlobDigests,
  resolveJournalItemId,
  type JournalReducerState
} from './journal-reducer'
import { JournalRowWriter } from './journal-row-writer'
import { restoreJournalStore } from './journal-store-restore'
import type { JournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'
import type { JournalBlobInput } from './journal-store-contracts'
import type { JournalAppendBudget } from './journal-write-guards'

export type JournalStoreHost = {
  identity: AgentSessionJournalIdentity
  journalDir: string
  dbPath: string
  budget: JournalAppendBudget
  now: () => number
  mintEpoch: () => string
  serialize: <T>(run: () => Promise<T>) => Promise<T>
  database: () => OpenJournalDatabase
  state: () => JournalReducerState
  readOnly: () => boolean
  setReadOnly: (readOnly: boolean) => void
  cursor: () => AgentJournalCursor
  adopt: (loaded: JournalLoad) => void
  commit: (row: JournalRow, physicalBytes: number) => void
  setPhysicalBytes: (bytes: number) => void
  /** A caller-supplied load, which suppresses replay entirely when present. */
  loaded: () => JournalLoad | null | undefined
  malformedRows: () => number
  setMalformedRows: (count: number) => void
  setQuarantinedRows: (count: number) => void
  journal: () => AgentSessionJournal
  enqueue: (
    build: (seq: number, ts: number) => JournalRow,
    blobs?: readonly JournalBlobInput[]
  ) => Promise<JournalRow>
}

export type JournalStoreCollaborators = {
  lifecycleAdmission: JournalLifecycleAdmission
  rowWriter: JournalRowWriter
  epochController: JournalEpochController
  itemAppender: JournalItemAppender
  lifecycleBatchAppender: JournalLifecycleBatchAppender
  /** Restores the store's state from disk. Owned here because it needs the same
   *  collaborators the constructor just built. */
  restore: () => Promise<void>
}

export function createJournalStoreCollaborators(host: JournalStoreHost): JournalStoreCollaborators {
  const lifecycleAdmission = new JournalLifecycleAdmission(
    host.identity.sessionId,
    host.budget.maxSessionBytes,
    (itemId) => resolveJournalItemId(host.state(), itemId),
    host.budget.maxAppendsPerWindow,
    () => host.database().pageSize
  )
  const epochController = new JournalEpochController({
    identity: host.identity,
    journalDir: host.journalDir,
    dbPath: host.dbPath,
    budget: host.budget,
    now: host.now,
    mintEpoch: host.mintEpoch,
    serialize: host.serialize,
    database: host.database,
    readOnly: host.readOnly,
    setReadOnly: host.setReadOnly,
    highestFence: () => host.state().highestFence,
    cursor: host.cursor,
    adopt: host.adopt,
    setPhysicalBytes: host.setPhysicalBytes
  })
  return {
    lifecycleAdmission,
    epochController,
    restore: () => restoreJournalStore(host, { epochController, lifecycleAdmission }),
    rowWriter: new JournalRowWriter({
      journalDir: host.journalDir,
      dbPath: host.dbPath,
      sessionId: host.identity.sessionId,
      budget: host.budget,
      lifecycleAdmission,
      now: host.now,
      serialize: host.serialize,
      database: host.database,
      readOnly: host.readOnly,
      highestFence: () => host.state().highestFence,
      nextSequence: () => host.state().lastSequence + 1,
      referencedBlobDigests: () => referencedBlobDigests(host.state()),
      commit: host.commit,
      setPhysicalBytes: host.setPhysicalBytes
    }),
    itemAppender: new JournalItemAppender({
      journal: host.journal,
      state: host.state,
      enqueue: host.enqueue
    }),
    lifecycleBatchAppender: new JournalLifecycleBatchAppender({
      state: host.state,
      cursor: host.cursor,
      enqueue: host.enqueue
    })
  }
}
