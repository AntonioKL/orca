# Dispatch failure race repair

## Outcome

Fixed the deterministic `database is locked` failure in `db-task-dispatch-races.test.ts` without weakening the stale-failure assertion, lifecycle compare-and-swap, receipt atomicity, or SQLite locking.

## Root cause

The lifecycle conversion changed `failDispatch` from an UPDATE-first savepoint to a read-then-update sequence. A top-level SQLite savepoint starts a deferred transaction, so the first connection acquired a read snapshot; when the fixture committed `settleWorkerReport` through a second WAL connection before the first lifecycle UPDATE, SQLite rejected the snapshot-to-writer upgrade as `SQLITE_BUSY_SNAPSHOT` (surfaced by `node:sqlite` as `database is locked`). `busy_timeout` does not resolve this class of snapshot upgrade, and retrying only the UPDATE would break the transition receipt/projection transaction.

## Fix

- `failDispatch` now uses `BEGIN IMMEDIATE` when it owns the outer transaction, reserving the WAL writer before its first lifecycle read. Competing writers wait at the transaction boundary and the winner's committed state is re-read before any CAS.
- When a caller already owns a transaction, `failDispatch` retains savepoint nesting and never commits or rolls back the caller's work. The sync SQLite adapter exposes `DatabaseSync.isTransaction` for this distinction.
- Projection updates and lifecycle receipts remain in the same transaction/savepoint. The existing rollback-on-task-transition-failure test remains unchanged and passing.
- The report-wins race fixture now commits the second connection immediately before the first connection executes `BEGIN IMMEDIATE`, a serializable boundary interleaving. It still asserts the completed task/dispatch/worker outcome and revoked capability, and now also asserts that no `dispatch_failed` receipt was written.
- A nested-transaction regression confirms `failDispatch` leaves the caller transaction open and that caller rollback removes the dispatch/task projections and lifecycle receipt together.

## Verification

- Reproduction before fix: `pnpm test src/main/runtime/orchestration/db-task-dispatch-races.test.ts` failed 1/3 at `transitionLifecycleWithDb(...).run(...)` with `Error: database is locked`.
- Stress after fix: race file passed 30/30 isolated iterations (4 tests per iteration).
- Final focused run: race file plus sync-database adapter tests passed 15/15 tests across 2 files.
- Related lifecycle/invariant run passed 88/88 tests across 8 files:
  - `db/lifecycle-transition.test.ts`
  - `db/lifecycle-transition-boundary.test.ts`
  - `db-task-dispatch-invariant.test.ts`
  - `db-task-dispatch-lifecycle-guards.test.ts`
  - `lifecycle-reconciliation.test.ts`
  - `dispatch-failure-idempotency.test.ts`
  - `db-heartbeat-straggler-guard.test.ts`
  - `orchestration-worker-dispatch-db.test.ts`
- `pnpm tc`: passed.
- `pnpm run check:code-quality:changed`: passed with 0 new findings across 127 changed files, including type-aware checks and React Doctor.
- `git diff --check`: passed with no output.

## Files modified

- `src/main/runtime/orchestration/db/dispatch-context/dispatch-completion.ts`
- `src/main/runtime/orchestration/db-task-dispatch-races.test.ts`
- `src/main/sqlite/sync-database.ts`
- `src/main/sqlite/sync-database.test.ts`
- `orchestration-db-task-dispatch-race-fix-report.md`

No work remains for this task.
