// What runs AFTER a journal transaction commits.
//
// A successful COMMIT is the operation's point of no return: the row or the
// epoch is durable whether or not the housekeeping behind it succeeds. Callers
// therefore adopt the committed state FIRST and run this second — a fallible
// measurement between COMMIT and adoption is exactly what lets the next append
// reuse a sequence the table already holds, or strands a live store on an
// epoch prefix that has just been deleted.
//
// Every step here is best-effort by design. A deferred checkpoint is carried by
// the WAL admission term, an unreclaimed freelist survives for the next
// attempt, and an unread directory falls back to the caller's projection, which
// is an upper bound on the footprint and so keeps admission failing closed.

import { journalDirectoryBytes } from './journal-physical-quota'

export type JournalPostCommitResult = {
  /** Footprint to carry forward: measured when the scan succeeded, and the
   *  caller's conservative projection when it did not. */
  physicalBytes: number
  /** The first best-effort failure, for callers that want to disclose it.
   *  Nothing durable is at risk when it is set. */
  error?: unknown
}

export async function runJournalPostCommit(input: {
  journalDir: string
  projectedBytes: number
  housekeeping?: () => Promise<void>
}): Promise<JournalPostCommitResult> {
  let error: unknown
  try {
    await input.housekeeping?.()
  } catch (failure) {
    error = failure
  }
  try {
    const physicalBytes = await journalDirectoryBytes(input.journalDir)
    return error === undefined ? { physicalBytes } : { physicalBytes, error }
  } catch (failure) {
    return { physicalBytes: input.projectedBytes, error: error ?? failure }
  }
}
