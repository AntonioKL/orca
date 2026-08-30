# Orchestration v3 lifecycle and persistence complexity audit

## Verdict

**Block on F1.** The new centralized lifecycle graph misses a production transition reached when a delayed PTY exit follows an uncertain stop. The rest of the audited design is conservative and generally transaction-safe, but worker composition, mutation idempotency, release convergence, and receipt correlation still carry avoidable branch/ledger complexity.

Scope was the current `orchestration-v3` working tree against `origin/main`, emphasizing lifecycle, composed worker start, SQLite persistence, Task/Dispatch/worker projection, receipts, release, and recovery. No tracked files were edited.

## Findings

### F1 — High — block: delayed exit after `stop_unknown` is rejected by the new lifecycle graph

Evidence:

- `src/main/runtime/orchestration/db/lifecycle-transition.ts:89-99` permits `stop_unknown -> stopped|abandoned`, but not `stop_unknown -> failed`.
- `src/main/runtime/orchestration/db/dispatch-context/dispatch-completion.ts:173-186` handles every positively observed worker process exit by transitioning the current worker state to `failed`.
- `src/main/runtime/orca-runtime.ts:19147-19175` routes a PTY exit for any still-active Dispatch through `failDispatch(..., { workerProcessExited: true })`.
- `src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-stop.ts:234-263` leaves the Dispatch active when stop outcome is unknown, so the later PTY-exit hook can reach exactly this combination.
- `src/main/runtime/orchestration/db-task-dispatch-lifecycle-guards.test.ts:132-147` tests process exit only from `ready`; the stop-unknown tests do not deliver a later positive exit.

Impact: after a lost stop response, a later real PTY exit throws `lifecycle_conflict` while the runtime is processing process death. The transaction rolls back, leaving the worker `stop_unknown`, the Dispatch active, and the Task blocked; it can also interrupt the remainder of exit cleanup because the authoritative `failDispatch` call is outside the best-effort notification `try` in `orca-runtime.ts:19177-19188`. This is a regression from `origin/main`, whose direct worker update allowed any nonterminal worker state to become `failed`.

Safe simplification: decide one canonical meaning and encode it once: either allow `stop_unknown -> failed` for the generic exit path, or special-case a positive exit after a stop request as `stop_unknown -> stopped` while settling the Dispatch/Task consistently. Add an integration test `ready -> stopping -> stop_unknown -> PTY exited` asserting no throw, revoked authority, terminal worker state, settled Dispatch, blocked/retryable Task, and one receipt per projection.

### F2 — Medium — simplify: concurrent identical `workerStart` calls bypass in-process coalescing

Evidence:

- `src/main/runtime/rpc/orchestration-mutation-executor.ts:82-101` treats worker start specially and performs only a DB lookup instead of atomically beginning the receipt.
- The existing `inFlight` promise is consulted only after a durable row is observed as `completed` or `pending` (`:109-146`). A call with no row proceeds without checking it.
- The promise is not installed until `:179-194`.
- Local composition performs asynchronous terminal/worktree validation before `createStartingWorkerDispatch` atomically inserts the acceptance receipt (`src/main/runtime/rpc/methods/orchestration-local-worker-start.ts:47-114`). Two same-request calls can therefore both classify themselves as `started`; one later wins DB acceptance and the other returns `operation_unknown` instead of coalescing on the first result.
- `src/main/runtime/rpc/orchestration-mutation-executor.test.ts:38-118` covers prompt receipt recovery, not concurrent atomic worker acceptance.

Impact: effects remain fenced by the DB receipt, so this is not a duplicate-worker bug, but an identical concurrent retry can receive an ambiguous failure while the original succeeds. That weakens the advertised idempotent composition contract and pushes avoidable inspection/recovery onto coordinators.

Safe simplification: consult/install `inFlight` before the special atomic-acceptance branch, or add an atomic acceptance-claim state that is created before asynchronous topology checks and can be safely discarded before effects. Add a `Promise.all` test for identical local and federated starts that expects one invocation/effect set and the same receipt with `replayed` metadata.

### F3 — Medium — simplify: release cannot converge automatically across close-success / DB-settlement loss

Evidence:

- Local release commits the archive/`releasing` state, closes the terminal, and only afterward marks the resource released (`src/main/runtime/rpc/methods/orchestration-worker-release-completion.ts:178-245`). A crash or SQLite error between `closeTerminal` and `settleWorkerTerminalRelease` leaves durable `releasing` state after the process is gone.
- Startup reconciliation selects `requested` and `releasing` rows (`src/main/runtime/orchestration/db/worker-terminal/worker-terminal-listing.ts:34-43`), but a missing/unattached terminal in recovery mode is returned as `release_pending` before process-incarnation liveness is consulted (`orchestration-worker-release-completion.ts:131-141`).
- The positive-exit convergence helper excludes the two backlog states: `settleDeadWorkerTerminalRelease` accepts only `not_requested|retained|unknown` (`src/main/runtime/orchestration/db/worker-terminal/worker-terminal-release.ts:133-152`).
- The interactive handler performs process-incarnation liveness convergence only for a `retained` disposition (`src/main/runtime/rpc/methods/orchestration-worker-release.ts:46-70`), not for a requested/releasing backlog row.

Impact: the safe close already happened, but the durable resource can remain pending/unknown indefinitely. The design correctly refuses to infer death from missing inventory; the gap is that it also fails to consume a later *positive* `exited` verdict for the exact process incarnation.

Safe simplification: on missing/unattached recovery, query exact process-incarnation liveness; when it is positively `exited`, allow an atomic `requested|releasing -> released` settlement using the already committed archive. Retain current pending behavior for `live`/`unverifiable`. Add a crash-seam test that injects failure immediately after successful close, reopens the DB, supplies `exited`, and converges without a second close.

### F4 — Medium — simplify: local and federated worker composition duplicate the same state machine

Evidence:

- Dependency parsing is duplicated verbatim in `src/main/runtime/rpc/methods/orchestration-local-worker-start.ts:274-289` and `orchestration-federated-worker-start.ts:35-51`.
- Local start separately assembles start options, creates the pending Task/Dispatch/worker transaction, records topology effects, waits for readiness, attaches authority, sends the preamble, and marks input accepted (`orchestration-local-worker-start.ts:79-270`).
- Home-side federated start repeats task/start-option normalization and pending acceptance (`orchestration-federated-worker-start.ts:135-172`), while the execution host repeats setup/readiness, authority, preamble delivery, effect recording, and failure classification (`src/main/runtime/rpc/methods/orchestration-federation.ts:198-297`).

Impact: receipt vocabulary and legal stages must stay aligned across three orchestration paths. The code already shows patch pressure around prompt budgets, setup evidence, launch preferences, and unknown outcomes; another stage or receipt field currently requires multi-file synchronization and parallel tests.

Safe simplification: keep host-specific effects separate, but extract one pure normalized start plan and one host-side `materialize -> ready -> attach authority -> deliver -> settle` driver parameterized by placement/transport adapters. Do not merge local and remote liveness policies or infer remote exit from transport loss.

### F5 — Low/Medium — defer then simplify: the lifecycle boundary contains a delivery-error exception

Evidence:

- The generic lifecycle primitive exposes `correction: 'unobserved_prompt_report'` (`src/main/runtime/orchestration/db/lifecycle-transition.ts:51-62`) and bypasses terminal-state legality for failed Task/Dispatch/worker rows (`:167-179`).
- Worker settlement imports `AGENT_PROMPT_STALLED_ERROR` from prompt-submission verification and has a large dedicated reopen branch (`src/main/runtime/orchestration/db/dispatch-context/worker-report-settlement.ts:3,90-121,165-254`).
- Current composed worker start uses queued acceptance with zero observation wait (`src/main/runtime/rpc/methods/orchestration-local-worker-start.ts:226-237`), and the runtime returns an honest input-accepted receipt rather than throwing when turn start is not observed (`src/main/runtime/orca-runtime.ts:21815-21894`).

Impact: the core state graph knows about one upper-layer delivery implementation error and can reopen otherwise terminal states. The branch is needed for legacy/pre-update rows, but it should not be the long-term normal lifecycle model.

Safe simplification: keep this compatibility path for existing failed-stall rows, but isolate it in a named legacy-repair operation with explicit provenance. New writes should represent uncertainty as `start_unknown/outcome_unknown`, which ordinary authenticated reports can settle without reopening terminal states. Remove the exception only after migration/compatibility coverage proves no supported row still depends on it.

### F6 — Low — keep semantics, simplify audit correlation later: four durable ledgers describe one worker report

Evidence:

- `mutation_receipts`, `lifecycle_transition_receipts`, and `attempt_observation_facts` are separate tables (`src/main/runtime/orchestration/db/schema/create-core-tables-sql.ts:95-147`), in addition to the durable message row/delivery.
- A worker report writes Task, Dispatch, and worker lifecycle receipts plus a worker-report observation (`src/main/runtime/orchestration/db/dispatch-context/worker-report-settlement.ts:167-294`). Lifecycle receipts have no causation/message-id column (`src/main/runtime/orchestration/db/lifecycle-transition.ts:122-130,219-247`).
- Atomic rollback and replay are well covered in `src/main/runtime/rpc/orchestration-commit-notify-characterization.test.ts:193-440`; the complexity is operability/correlation, not transaction safety.

Disposition: **keep** the separate purposes and existing atomic transaction. Later, add an optional causation ID to lifecycle receipts and populate it with the message/mutation ID so one report can be queried across ledgers; do not add a fifth event store or replace the projections in this PR.

## High-value missing tests

1. `stop_unknown` followed by positive PTY exit (F1) — required before merge.
2. Concurrent same-request local and federated `workerStart` coalescing (F2).
3. Crash after terminal close but before release settlement, then exact `exited` recovery (F3).
4. Table-driven coverage for every production transition edge used by `failDispatch`, stop, abandon, retry, start-unknown reconciliation, and worker report. The current lifecycle unit test has only two generic cases (`src/main/runtime/orchestration/db/lifecycle-transition.test.ts:4-49`).
5. Expand the direct-writer ratchet beyond its hard-coded eight-file list (`src/main/runtime/orchestration/db/lifecycle-transition-boundary.test.ts:5-23`) or replace it with a recursive production-source scan. Remote attachment lifecycle remains a parallel direct-SQL state machine in `remote-dispatch-attachment-authority.ts:116-160`, `remote-dispatch-attachment-stop.ts:8-66`, and `federation-relay-item.ts:23-57`; characterize stop/report/start races before centralizing it.

## Positive dispositions

- **Keep:** `BEGIN IMMEDIATE` ownership for read-before-write Task/Dispatch failures (`dispatch-completion.ts:109-218`) and nested-savepoint behavior; it addresses the WAL snapshot-upgrade race without weakening CAS.
- **Keep:** worker-done message, lifecycle projection, attempt fact, and mutation receipt in one transaction before notification (`orchestration.ts:905-914` plus the commit-notify characterization tests).
- **Keep:** conservative exact pane/process/host checks before terminal close (`orchestration-worker-release-completion.ts:95-129,194-245`) and `live/unverifiable/exited` separation.
- **Keep:** same-outcome duplicate worker reports preserving the first canonical Task result. The current contract explicitly accepts duplicate same-outcome federated reports even when bodies differ (`orchestration-federation-lifecycle-settlement.test.ts:614-656`); document that first-result-wins rule rather than adding content-based settlement branches.

## Verification note

A focused Vitest invocation covering lifecycle transitions, Task/Dispatch guards and races, mutation execution, and release recovery was started. The environment was concurrently running many other Vitest pools; the tool yielded after progress dots and the process later exited, but its final summary/exit status was not retained, so this audit does not claim that run as verification evidence. Static evidence for F1 is a direct production call-chain/transition mismatch and does not depend on a failing existing test.
