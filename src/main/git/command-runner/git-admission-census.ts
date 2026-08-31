import { _gitAdmissionSnapshotForTests } from './git-subprocess-admission'

/** Counts-only production accessor; excludes command arguments and paths. */
export function gitAdmissionCountsSnapshot(): { inflight: number; queued: number } {
  const snapshot = _gitAdmissionSnapshotForTests()
  let inflight = 0
  for (const budget of Object.values(snapshot.budgets)) {
    inflight += budget.baseUsed + budget.headroomUsed
  }
  return { inflight, queued: snapshot.queued }
}
