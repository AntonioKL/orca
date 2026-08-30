# Final orchestration vNext release audit

## Verdict

**READY.** The implementation is green, the F1, F2, and prior L1-L4 source
repairs are closed, and the reconciled HTML audit now matches the implemented
public boundary. Retention-expiry metadata, TTL policy, and bulk cleanup are
explicitly validate-first follow-up work, not committed implementation scope.

The final independent review found and closed four concrete gaps before this
sign-off: exact-authority completion after `start_unknown`, unguarded Task
status writes in decision-gate/context-only release paths, A-era completion
compatibility, and host-aware liveness fallback. A deterministic SQLite
`SQLITE_BUSY_SNAPSHOT` race in `failDispatch` was also fixed with an
outer-transaction `BEGIN IMMEDIATE` boundary while retaining savepoint nesting
for caller-owned transactions. These repairs are covered by the focused and
full orchestration suites below.

Physical SSH, WSL, and provider-version certification remains unperformed. The
deterministic topology, compatibility, and provider fixtures are green, but they
do not replace those separate physical certification jobs.

The final supervised review Run completed all eight Tasks and acknowledged every
Delivery. Review terminals exited before cleanup could observe their tabs, so
release returned the safe `release_unknown` receipt with transcript archives
captured (one resource is explicitly retained as `identity_unproven`); no broad
terminal close or unverifiable process claim was made.

## F1 cleanup/retention verification

- The public cleanup/retention portion of the worker CLI contains explicit
  `worker-release`, indefinite `worker-retain`, and paginated `worker-list` only;
  retain has no expiry/policy flags
  (`src/cli/specs/orchestration-worker-specs.ts:87-123`). The registry test proves
  the cleanup command and TTL flags are absent while retain still calls
  `orchestration.workerRetain` (`src/cli/handlers/orchestration-worker-cli.test.ts:366-389`).
- RPC retain accepts only a strict Dispatch object, and list exposes only run,
  terminal state, cursor, limit, and optional remote inclusion
  (`src/main/runtime/rpc/methods/orchestration-worker-release-schemas.ts:5-22`).
  The method registry explicitly excludes `orchestration.workerCleanup`
  (`src/main/runtime/rpc/methods/orchestration-runs.test.ts:27-34`).
- Unknown retention-expiry/policy fields are rejected before ownership or process
  state changes (`src/main/runtime/rpc/methods/orchestration-worker-release.test.ts:812-829`).
- The resource table retains ownership/release/archive/recovery facts but has no
  retention expiry or policy column
  (`src/main/runtime/orchestration/db/schema/create-core-tables-sql.ts:168-215`).
- Explicit release, user-requested indefinite retain, later release, list, and
  archive preservation remain implemented
  (`src/main/runtime/rpc/methods/orchestration-worker-release.ts:35-155`,
  `src/main/runtime/rpc/methods/orchestration-worker-release.ts:153-295`,
  `src/main/runtime/rpc/methods/orchestration-worker-archive-read.ts:28-69`).

## F2 Task lifecycle verification

- The legal Task graph restores `pending -> failed|completed|blocked` while
  retaining terminal-state and retry constraints
  (`src/main/runtime/orchestration/db/lifecycle-transition.ts:33-44`).
- `updateTaskStatus` routes through the guarded transition boundary. A real invalid
  edge rethrows typed `lifecycle_conflict`; only a concurrent writer that already
  applied the exact requested status is treated as an idempotent success
  (`src/main/runtime/orchestration/db/tasks/task-status-transition.ts:67-90`).
- Regression tests exercise all three restored pending transitions, downstream
  readiness behavior, durable receipts, and an invalid `blocked -> completed` edge
  with typed conflict data and no mutation
  (`src/main/runtime/orchestration/db-task-dispatch-invariant.test.ts:28-63`).
- The same suite retains forced interleaving, active-Dispatch, supervised-worker,
  federated-start, rollback, and same-pane occupancy races
  (`src/main/runtime/orchestration/db-task-dispatch-invariant.test.ts:65-99,209-300,344-422`).

## L1-L4 closure review

- **L1 lifecycle centralization:** the transition primitive enforces explicit
  Task/Dispatch/worker graphs and compare-and-swap updates before atomically
  appending receipts (`src/main/runtime/orchestration/db/lifecycle-transition.ts:33-63,104-173`).
  The direct-write ratchet covers the cited production writer set
  (`src/main/runtime/orchestration/db/lifecycle-transition-boundary.test.ts:5-21`).
- **L2 local/folder host classification:** null host scope projects as local, and
  the folder-authority regression proves fresh local liveness remains live
  (`src/shared/orchestration-fleet-projection.ts:205-241`,
  `src/shared/orchestration-fleet-projection.test.ts:106-129`).
- **L3 federation liveness:** missing old-peer verdicts and contact loss remain
  `unverifiable`; only an explicit execution-host verdict yields `exited`
  (`src/main/runtime/rpc/methods/orchestration-federation-control.ts:281-311`,
  `src/main/runtime/rpc/methods/orchestration-federation-liveness-verdict.test.ts:102-123,145-199`).
- **L4 federated release convergence:** confirmed host release idempotently clears
  the home worker and remote handles through a lifecycle receipt; ambiguity stays
  `release_unknown`
  (`src/main/runtime/rpc/methods/orchestration-federated-worker-release.ts:40-125`,
  `src/main/runtime/rpc/methods/orchestration-federation-output.test.ts:418-473`).

## Build-now and deferred-boundary review

The implemented build-now slices have concrete source and regression evidence:
prompt queued/submitted receipts; commit-before-notify replay; rejected/late
worker-report observations; atomic `worker-start --spec`; archive/liveness
separation; execution-host transcript routing; Dispatch/Resource identity reuse;
clock-domain-safe observation facts; source/completeness metadata; and
mixed-version capability caching. Representative evidence is in
`src/shared/runtime-terminal-contracts.ts:202-208`,
`src/main/runtime/rpc/orchestration-commit-notify-characterization.test.ts:76-212`,
`src/main/runtime/orchestration/db/dispatch-context/worker-report-settlement.ts:35-186`,
`src/main/runtime/rpc/methods/orchestration-worker-start-schema.ts:11-50`,
`src/main/runtime/orchestration/worker-transcript-read.ts:49-68`, and
`src/main/runtime/orchestration/db/attempt-outcome-projection.ts:27-81`.

Static source/served-guide scans found no speculative orchestration command or
flag for `work start`, attention waits, worker recovery/retry/cleanup, dependency
aliases, or context-bound completion. The only takeover grammar is the established
legacy-authority path. No second Attempt, Resource, lease, or renderer state store
exists: `dispatch_contexts` remains Attempt identity,
`worker_terminal_resources` remains Resource identity, and
`attempt_observation_facts` is an additive fact ledger rather than an identity
store (`src/main/runtime/orchestration/db/schema/create-graph-tables-sql.ts:95-153`,
`src/main/runtime/orchestration/db/schema/create-core-tables-sql.ts:168-215`,
`src/main/runtime/orchestration/db/attempt-observation-store.ts:91-160`).

Machine liveness remains `live` / `unverifiable` / `exited`; legacy terminal
presentation may separately render `running` / `unknown` while retaining the
canonical liveness field
(`src/main/runtime/rpc/methods/orchestration-worker-archive-read.ts:242-254`).
Served orchestration kernel/reference sources contain none of the audited
reference-product or compound-methodology names, and the changed/untracked source
and test marker scan is clean. No required mobile field, Git command, WSL command,
dependency, stream opcode, or duplicate mobile-facing state was introduced.

## Verification

- Full orchestration suite: **137 files, 1,314 tests passed**.
- Final focused lifecycle/mailbox/skill suite: **16 files, 225 tests passed**.
- Host-aware liveness and release suite: **7 files, 83 tests passed**.
- Race repair stress: **30/30 isolated iterations passed**; race plus SQLite
  adapter checks: **15/15 tests passed**.
- `pnpm tc` — passed.
- `pnpm tc:node` — passed.
- `pnpm tc:cli` — passed.
- `pnpm run check:code-quality:changed` — passed with zero new findings across
  127 changed files (including type-aware and React checks).
- `git diff --check` — passed.
- Served skill generation/guide tests: **32 tests passed**; compact output is
  materially smaller than `--full`, and all seven bundled references resolve.
- Static public-surface, served-guide vocabulary, identity-store, liveness, and
  unfinished-code marker scans — passed.
- Final HTML/public-surface static assertions — passed.

## Artifact reconciliation

P4 now retains only evidence-backed resource accounting, recovery/archive, and
explicit retain/release work. Its retention-expiry metadata, TTL policy, and
paginated/bulk-cleanup language is explicitly a deferred validate-first follow-up
with measurement and policy/fencing acceptance gates
(`orchestration-vnext-implementation-audit.html:758-797`). R6 likewise names
`existing-resource release/archive accounting` and nests retention expiry, TTL
policy, and bulk cleanup under `validate first`
(`orchestration-vnext-implementation-audit.html:1278-1279`). No implementation
or plan change is required for release sign-off.
