# Orca main orchestration identity/lifecycle audit

## Executive summary

The current main-process orchestration kernel has a durable SQLite model for Runs, Tasks, Dispatch contexts, worker state, messages, and worker-terminal resources. It already fences most stale or foreign lifecycle messages, serializes Task/Dispatch races, accumulates retry failures into a circuit breaker, and makes terminal cleanup an explicit request/archive/close/reconcile flow. The remaining reliability boundary is that these are still several projections and heuristics rather than one Attempt event log: startup `ready` means input was accepted by Orca, `worker_done` is the only positive completion fast path, Task status can be edited through multiple APIs, and remote/SSH observation plus unsupervised lanes remain explicitly incomplete.

This audit maps observed behavior to implementation slices, non-goals, dependencies, and independently verifiable tests. It intentionally proposes contract/test work only; no source or `orchestration-issues.md` changes are included.

## Scope and evidence

Primary implementation inspected:

- `src/main/runtime/orchestration/db/schema/create-core-tables-sql.ts` and `create-graph-tables-sql.ts` (schema, constraints, indexes).
- `db/dispatch-context/*` (capabilities, lookup, completion, worker-report settlement, Task reconciliation).
- `db/worker-dispatch/*` (start, authority, readiness, stop, abandon, missing-terminal recovery, federated start/stop).
- `db/worker-terminal/*` plus `worker-terminal-ownership.ts` and `worker-terminal-release-reconciliation.ts` (lease ownership, transfer, archive, release, user takeover).
- `lifecycle-reconciliation.ts`, `coordinator.ts`, `coordinator-task-dispatch.ts` (message authority and coordinator projection).

Representative tests include `lifecycle-reconciliation.test.ts`, `orchestration-worker-dispatch-db.test.ts`, `db-task-dispatch-{invariant,races,lifecycle-guards}.test.ts`, `db-heartbeat-straggler-guard.test.ts`, `coordinator.test.ts`, `orchestration-worker-release-recovery.test.ts`, `orchestration-worker-stop-liveness-verdict.test.ts`, federation tests, migration tests, and RPC delivery/receipt tests.

## Entity and identity map

| Entity                     | Current durable identity/evidence                                                                                                                 | Current authority rule                                                                                                    | Audit implication                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Run/coordinator            | `runs.id`, coordinator handle/pane; handle history in `run_coordinator_handles`; `coordinator_runs` scheduler row                                 | Run mailbox routing and coordinator ownership are DB-derived; legacy adoption has separate compatibility principals       | Good Run-level routing, but scheduler/Run/role identity is not one immutable actor record.                                        |
| Task                       | `tasks.id`, `run_id`, parent, dependency JSON, creator handle/pane/process/generation                                                             | Task status transitions require/forbid active Dispatch depending on target state; dependency completion promotes children | Status is a projection maintained by several writers, not an append-only Attempt fact.                                            |
| Dispatch/Attempt           | `dispatch_contexts.id`, task/run, contract version, assignee handle, pane key, process incarnation, capability hash, depth, status, failure count | Capability + pane/process and status gates lifecycle writes; retry must name current terminal Dispatch                    | This is the strongest current identity boundary, but capability is mutable and no immutable Attempt event stream exists.          |
| Worker execution           | `worker_dispatches.dispatch_id`, runtime epoch, state/stage, setup/effects/residual resources, terminal handle                                    | Starting/ready/stopping/settled state machine; process exit can force-fail                                                | `ready/input_accepted` does not prove provider turn-start or prompt submission.                                                   |
| Terminal resource lease    | `worker_terminal_resources.id`, owner/origin/prior owners, pane/process/host identity, ownership/release state                                    | Exact identity re-proven before close; external/user-owned/transferred resources retained                                 | Lease state is durable and conservative, but there is no TTL/bulk cleanup and federated release is unsupported.                   |
| Message/lifecycle evidence | Immutable message id/sequence, type, sender pane, payload; rejection marker persisted                                                             | `worker_done`/heartbeat require dispatch id and assignee pane (or exact legacy handle)                                    | Rejection and duplicate suppression work; generic status/progress remains non-authoritative and no unified receipt cursor exists. |

## Current state and transition behavior

### Identity and authority

- Pane keys are remint-stable by parsed leaf UUID; opaque keys require exact equality (`lifecycle-reconciliation.ts:5-27`). A pane-bound Dispatch ignores handle churn, while a legacy row without pane identity accepts only exact handle equality.
- Dispatch capabilities are hashed at rest, timing-safe compared, revoked on stop/failure/completion, and require equivalent pane plus matching process incarnation (`db/dispatch-context/dispatch-capability.ts`). `prepareStartingWorkerAuthority` atomically records assignee/process/capability and rejects a second active Dispatch for the same handle/pane.
- Dispatch occupancy is checked by handle, exact pane, then parsed pane suffix. The writer boundary centralizes all live-worker inserts and stamps nesting depth (`db/dispatch-row-writer.ts`); migrations default unknown depth to 1 (fail-closed for child spawning).
- Canonical `dispatch:<id>` senders are permitted for imported/federated paths where explicitly enabled; ordinary lifecycle reconciliation uses sender pane/legacy handle, not payload claims.

Implementation work (I1 — stable actor/attempt identity):

1. Add immutable Agent, Endpoint, Attempt, and Resource IDs and an actor/role binding table; treat terminal handles and pane keys as ephemeral addresses.
2. Make capability issuance/refresh an explicit Attempt operation; bind every completion, heartbeat, question, cleanup, and nested dispatch to Attempt + process incarnation + host scope.
3. Expose role/parent/depth and an `unsupervised` state in every worker/show/list projection, including adopted/context-only rows.

Non-goals: do not remove pane-key compatibility, rotate all IDs in one migration, or infer stable identity from terminal title, provider name, or model-copied text. Do not make a foreign handle authoritative merely because it claims a valid Dispatch id.

Dependencies: vocabulary/invariant contract (I0) before schema/API changes; runtime/IPC caller identity; remote wire optional fields and capability negotiation; migration/backfill strategy for v30 and legacy principals.

Tests: extend `lifecycle-reconciliation.test.ts` for capability refresh, process-incarnation mismatch, nested parent/child completion, and stale Attempt after retry; extend `db-task-dispatch-races.test.ts` for concurrent remint claims; add a migration test proving old rows remain fail-closed; add an RPC integration test that caller identity cannot be supplied in payload text.

### Dispatch creation and startup

- Normal `createDispatchContext` atomically claims a ready Task, records assignee identity/depth, and marks the Task dispatched. Composed `createStartingWorkerDispatch` atomically records mutation receipt + pending Dispatch + worker `starting` row (+ federation attachment) and clears prior Task result.
- Authority attachment records terminal/worktree/setup/effect evidence and creates or transfers a terminal lease. `markWorkerDispatchReady` changes context to dispatched and worker to `ready/input_accepted`; `markWorkerStartUnknown` revokes capability and blocks the Task without asserting process death. Start failure settles Dispatch/worker and fails Task when no sibling remains.
- The coordinator creates at most one terminal per tick and polls pre-created Tasks; `decompose()` explicitly does not create a DAG.

Implementation work (I2 — honest delivery/readiness and atomic start):

1. Add a receipt/state vocabulary (`recorded`, `routed`, `endpoint_delivered`, `terminal_queued`, `provider_submitted`, `turn_started`, `report_persisted`, `settled`, `outcome_unknown`) instead of overloading `ready/input_accepted`.
2. Make common `task-create + worker-start` idempotent and atomic while preserving standalone Task creation for planned fan-out; persist partial effects and exact retry command.
3. Give providers a readiness capability and distinguish slow/unavailable endpoint from process exit; on input failure mark the endpoint unusable or roll back, never leave a silently live lane.

Non-goals: do not claim provider turn-start from a PTY write, title scrape, or successful local enqueue; do not auto-fail a worker solely because a readiness observer timed out; do not make AI decomposition part of this kernel slice.

Dependencies: I0 receipt definitions; provider adapter contract; mutation receipt capacity/idempotency; execution-host runtime (for SSH, WSL, and remote server evidence).

Tests: add unit tests for each readiness stage and duplicate request receipt; integration tests for write accepted-but-provider-not-started, slow boot, truncated prompt, and reconnect replay; retain `orchestration-worker-dispatch-db.test.ts` transactional acceptance/rollback tests and add cross-version optional-field coverage.

### Completion, heartbeat, and Task/Dispatch projection

- `worker_done` parsing requires object payload, `taskId`, `dispatchId`, and `outcome`; it verifies Task existence, Dispatch ownership/task match, sender authority, then calls transactional `settleWorkerReport`.
- Settlement rejects inactive/stale Dispatches, refuses completion while another supervised sibling is active, atomically updates Task + Dispatch + worker state, closes questions, promotes dependency-ready children, and treats identical settled reports as duplicates. Earlier same-Dispatch heartbeats are marked read; late heartbeats on inactive Dispatches are suppressed.
- Generic `completeDispatch`, `updateTaskStatus`, escalation failure, process-exit failure, and missing-terminal recovery are additional writers. `failDispatch` increments a three-failure circuit breaker, requeues Task to ready unless circuit-broken, and refuses failure while a supervised worker remains active unless process exit is proven.
- Coordinator processing is a polling loop; it records completed/failed task IDs in in-memory state and marks all read messages after per-message handling.

Implementation work (I3 — one Attempt lifecycle and completion truth):

1. Introduce an append-only Attempt event/receipt table and derive Task/Dispatch projections from it; fence late/reordered/duplicate events by Attempt sequence/causation id.
2. Separate process/turn observation, artifact/Git evidence, worker report, and coordinator acknowledgment; add explicit `finished_unverified`/`outcome_unknown` rather than treating `ready` or missing report as healthy.
3. Make heartbeat age host-computed and expose `never`, age, and `unverifiable`; keep `live`/`unverifiable`/`exited` distinct on SSH/remote loss.
4. Return typed rejection/failure receipts with whether mutation may have happened and an idempotent next command; wake coordinator from durable writes instead of relying only on polling.

Non-goals: `worker_done` remains a useful fast path; this work does not require trusting prose over host evidence, automatic success from Git cleanliness, or removal of heartbeat suppression. Do not collapse remote transport loss into `exited`.

Dependencies: I1 Attempt identity; I2 delivery receipts/provider observation; SSH execution boundary; durable mailbox/ack cursor; existing circuit-breaker and Task dependency semantics.

Tests: preserve and extend `lifecycle-reconciliation.test.ts` (foreign pane, handle remint, duplicate, heartbeat suppression); `db-task-dispatch-lifecycle-guards.test.ts` (active sibling, process exit, stop race); `db-task-dispatch-races.test.ts` (late failure vs report); add event-order/replay tests, missing-report observation tests, and SSH `live/unverifiable/exited` integration tests.

### Stop, retry, abandon, and recovery

- `beginWorkerStop` accepts `ready` or `start_unknown`, revokes capability, reblocks Task when no sibling remains, closes questions, and moves worker to `stopping`; `settleWorkerStop`/federated reconcile moves to stopped and Dispatch failed. `stop_unknown` intentionally remains potentially live until reconciled.
- `abandonWorkerDispatch` is idempotent for abandoned rows, a no-op for superseded Dispatches, and handles context-only legacy rows; it refuses stopping or succeeded workers. `reconcileMissingWorkerTerminal` turns active rows into failed/ready (or circuit-broken/failed), marks worker abandoned/stopped, and is idempotent.
- Retry is allowed only from the Task's current terminal Dispatch and failed/stopped/abandoned worker state; failure count carries across attempts. Legacy recovery lists potentially live worker rows for startup reconciliation.

Implementation work (I4 — first-class recovery supervisor):

1. Persist transition receipts for stop/cancel/supersede/retry/abandon/recover/takeover, including partial effects and safe next action.
2. Add a mechanical restart/reconnect supervisor with bounded retries and one convergence result; never use missing client inventory as proof of remote exit.
3. Distinguish `cancelled`, `superseded`, `abandoned`, `failed`, and `outcome_unknown` in projections and CLI/API; make stale detector output actionable instead of warning-only.

Non-goals: no broad terminal close, no automatic retry that can duplicate worktree/process ownership, and no coordinator policy that kills an uncertain SSH process. Preserve current stop fence ordering and circuit-breaker threshold until a versioned policy changes it.

Dependencies: I1 identity, I2 receipts, I3 Attempt events; host-side process liveness and remote relay; mutation receipts.

Tests: extend `orchestration-worker-dispatch-db.test.ts` for every transition and idempotent replay; `db-task-dispatch-lifecycle-guards.test.ts` for sibling/reblock behavior; `federation-terminal-recovery.test.ts` for bounded remote retry; add restart/reconnect integration tests that verify no duplicate Dispatch and no false exit.

### Worker-terminal ownership and release leases

- Lease rows capture origin/current/prior owner, worktree, terminal/pane/process/host identity, ownership (`owned`, `external`, `user_owned`, `transferred`, `released`), release intent/state, retention reason, archive metadata, and timestamps.
- Newly created terminals are `owned`; explicit external reuse creates `external`; exact settled owned resources may transfer to a retry and record prior owner. Legacy backfill is always `external + retained + legacy_ambiguous`.
- Release is post-settlement only. `requestWorkerTerminalRelease` records durable intent, but retains stopped/abandoned, external, user-owned, transferred, no-resource, and federated resources. Completion re-proves handle/pane/process/host identity, captures transcript/tail archive, closes only the exact terminal, and marks `released`; missing/unavailable/failed close yields `release_pending`, `release_unknown`, or retained. Startup reconciliation retries only requested/releasing backlog and coalesces concurrent passes.
- Real user input marks a matching owned resource `user_owned + retained(user_takeover)` and deletes its release archive. Worker list derives process accounting separately from Task/Dispatch outcome (`active`, `reclaimable`, `retained`, `release_pending`, `release_unknown`, `released`).

Implementation work (I5 — complete lease lifecycle):

1. Make lease owner a first-class projection for process, terminal/pane, worktree, and setup surface; settle exactly once into release/retain/suspend/takeover with reason and optional TTL.
2. Add bulk and per-row idempotent “clear Done”/release, retention expiry, and explicit historical-vs-live listing; keep archives queryable after process release.
3. Implement worker-server/federated release protocol (capability-negotiated); until then keep `federation_unsupported` visibly retained.
4. Make missing-tab bookkeeping idempotently settle only with positive host `exited` evidence; retain `unverifiable` otherwise.

Non-goals: never close a broad pane by handle/title, never release external/user-owned/transferred resources automatically, and never delete evidence as part of a normal list operation. No TTL should override user takeover or an unresolved identity conflict.

Dependencies: I1 stable Resource/Attempt identity; I3 completion evidence; I4 recovery supervisor; transcript/archive API; remote wire compatibility and host-side close endpoint.

Tests: `orchestration-worker-release-recovery.test.ts` already covers requested/releasing restart recovery, unavailable terminal, untouched backlog, concurrency, and list counts; add tests for TTL/retention, transfer fencing, identity conflict, user input racing release, archive durability, bulk idempotency, and federated capability negotiation. Keep `orchestration-worker-stop-liveness-verdict.test.ts` assertions that unknown is not exited.

### DAG and coordinator behavior

- Tasks store `deps` JSON and are initially `pending` unless every dependency is completed; `promoteReadyTasks` runs in completion transactions and marks dependents ready. Parent/run IDs are checked for same-Run ownership. Coordinator dispatches ready tasks up to `maxConcurrent`, one terminal creation per tick, and converges only when all Tasks are terminal.
- There is no cycle detection, immutable DAG snapshot, attempt-level graph, or atomic fan-out/create+dispatch. `decompose()` requires pre-created Tasks and explicitly leaves AI decomposition for a future phase. Task status is still independently writable (guarded, but not event-derived), and a single Run query is not yet a fleet/agent graph.

Implementation work (I6 — DAG projection and fleet query):

1. Validate DAG acyclicity and same-Run dependency closure at creation; persist a Run-scoped graph/version so retries do not rewrite topology.
2. Derive readiness/convergence from Attempt events and dependency facts; expose blocked reason and unsatisfied dependency IDs.
3. Add one bounded fleet query returning Run/Task/Attempt/role/provider/host/worktree/stage/heartbeat/exit/evidence/lease/next action; use it for coordinator and UI instead of per-lane polling.

Non-goals: no AI decomposition in the reliability kernel, no merge queue or cost budget in this slice, and no second graph/state store in the UI. Existing independent Task creation remains supported.

Dependencies: I1 Attempt/role identity, I3 event-derived completion, I4 recovery states, I5 lease projection; query pagination and remote host routing.

Tests: extend `db-task-create-readiness.test.ts` for cycles/cross-run deps and interleaved completion; `db-task-dispatch-invariant.test.ts` for atomic fan-out races; `coordinator.test.ts` for max-concurrency/convergence and one-wave behavior; add fleet-query integration tests across local, folder workspace, SSH, WSL, and federated rows.

## Explicit non-goals and compatibility constraints

- Do not rewrite or delete legacy compatibility tables/routes in the first slice; dual-write/dual-read with parity tests and bounded migration is safer.
- Do not conflate coordination hierarchy, filesystem/worktree isolation, Git lineage, execution host, UI grouping, or notification audience.
- Do not infer process death from client inventory absence, timeout, socket loss, or a quiet terminal. SSH execution belongs to the execution host; use `live`/`unverifiable`/`exited` only.
- Do not add a new remote stream opcode without capability negotiation. New lifecycle receipt fields should be optional and old readers must remain safe.
- Do not expand this audit into renderer UX, notification policy, Git merge behavior, or provider implementation; those consume the contracts above and need their own audits.

## Dependency DAG and safe parallelization

```text
I0 vocabulary + invariants
├── I1 stable identity/authority ───────┐
├── I2 delivery/readiness receipts ─────┼── I3 Attempt events + completion truth
└── mailbox ack/wakeup contract ────────┘         ├── I4 recovery supervisor
                                                  ├── I5 resource leases
                                                  └── I6 DAG projection/fleet query
I1 + I2 + I3 + I4 + I5 ──> attention/UI projections and provider/remote adapters
```

Safe parallel work after I0 (each with isolated schema/API ownership):

1. I1 identity schema/capability tests and I2 provider receipt/readiness tests can proceed in parallel if both use additive fields and share only the I0 vocabulary.
2. Mailbox ack/wakeup work can proceed beside I1/I2; it must consume immutable Attempt/message IDs rather than invent another identity.
3. I4 recovery tests can begin against current states while I3 event storage is designed, but implementation should land after the Attempt event contract is fixed.
4. I5 lease/archive work can proceed beside I3 once its owner key is stable; federated release adapter is independently parallel after remote capability negotiation is specified.
5. I6 DAG validation/readiness tests can proceed independently of terminal cleanup, then integrate with I3-derived completion and I5 lease fields.

Unsafe to parallelize: changing status enums, capability authority, or remote verdict vocabulary independently; changing worker-list projections before lease semantics are fixed; adding provider-specific lifecycle signals before receipt stages are agreed; or modifying legacy migration and reset behavior without compatibility fixtures.

## Definition of independently verifiable completion

Each implementation slice is complete only when its unit tests cover valid, duplicate, late, reordered, unauthorized, and restart/reconnect paths, and an integration test proves the durable DB projection plus runtime-visible receipt. A release is not complete if it merely closes a PTY; a Dispatch is not complete if only a message or UI status says done; and a remote process is not exited unless the owning host positively proves it.
