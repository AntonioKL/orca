# Orchestration vNext source review

Review target: current worktree changes against `orchestration-vnext-implementation-audit.md`,
`orchestration-vnext-implementation-audit.html`, and `orchestration-final-release-audit.md`.
Inspection was read-only apart from this report artifact.

## Verdict

**Not ready for an unconditional READY sign-off.** The focused tests and node typecheck are green,
but the source still has two concrete lifecycle-contract blockers: valid worker completion after an
uncertain start is rejected, and two production Task-status writers bypass the guarded transition
boundary and durable lifecycle receipts. The final audit's “READY” claim therefore overstates the
implemented lifecycle coverage.

## Blockers

### B1 — `start_unknown` worker reports cannot settle

`markWorkerStartUnknown` deliberately leaves the Dispatch active and moves the Task to `blocked`
(`src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-outcome.ts:102-140`). A later
authenticated `worker_done` therefore reaches `settleWorkerReport` with `task.status ===
'blocked'`, which is rejected by the `dispatch.status/task.status === 'dispatched'` guard
(`src/main/runtime/orchestration/db/dispatch-context/worker-report-settlement.ts:75-91`). Even if the
Task guard were relaxed, the worker transition is hard-coded to `from: 'ready'` and rejects
`start_unknown` (`.../worker-report-settlement.ts:164-171`). This contradicts the implementation
audit's P3 verification requirement for “report-after-reconnect” and strands a real worker that
started while the start RPC was ambiguous; add a regression test that marks a worker
`start_unknown`, delivers an exact-authority `worker_done`, and expects normal settlement.

### B2 — Task lifecycle writes still bypass the transition primitive

The direct-write ratchet only scans six files (`src/main/runtime/orchestration/db/lifecycle-transition-boundary.test.ts:5-21`),
but production writes remain in:

- `src/main/runtime/orchestration/db/decision-gates/decision-gate-store.ts:67-76` — `createGate`
  executes `UPDATE tasks SET status = 'blocked'` after inserting the gate and completing active
  dispatches. No compare-and-swap edge check or `lifecycle_transition_receipts` row is produced.
- `src/main/runtime/orchestration/context-only-dispatch-release.ts:37-58` — context-only release
  directly sets the Dispatch to `failed` and conditionally sets the Task to `blocked`, again with no
  guarded transition or receipt.

Both paths are reachable production lifecycle operations, not test fixtures. They can silently
overwrite an invalid/concurrent state and violate P3's “every lifecycle writer … updates legacy
projections and appends receipts atomically” requirement. Expand the ratchet and route both writes
through `transitionLifecycleWithDb` (with savepoint/transaction coverage).

## Validate-first / deferred items

- **Remote attachment state ordering:** `recordRemoteAttachmentStage` accepts arbitrary `state`
  replacements with no legal-transition/CAS check or lifecycle receipt
  (`src/main/runtime/orchestration/db/federation/remote-dispatch-attachment-create.ts:77-126`).
  Stop/relay settlement has additional direct state updates in
  `db/federation/remote-dispatch-attachment-stop.ts` and `db/federation/federation-relay-item.ts`.
  Existing federation tests cover authentication/ack/liveness, but not stale or reordered stage
  updates; characterize those races before treating remote lifecycle as fully centralized.
- **Recovery receipt identity:** `recordWorkerTerminalRecoveryAttempt` stores a receipt with
  `entity='worker'` but `entity_id=<resource id>` (`src/main/runtime/orchestration/db/worker-terminal/worker-terminal-resource-store.ts:124-143`).
  Worker lifecycle IDs are dispatch IDs, so `getLifecycleTransitionReceipts('worker', dispatchId)`
  cannot retrieve these recovery facts. Decide whether this is a separate resource-receipt domain
  or bind the receipt to the owning dispatch, then add a query/assertion test.
- **Physical certification remains outstanding:** SSH, WSL, and provider-version certification is
  explicitly unperformed in `orchestration-final-release-audit.md:5-10`; deterministic fixtures do
  not replace those jobs.
- **Retention expiry/TTL/bulk cleanup:** correctly remains validate-first/deferred per
  `orchestration-final-release-audit.md:129-133`; no blocker provided those features stay absent.

## Verification performed

- `pnpm test src/main/runtime/orchestration/db/lifecycle-transition.test.ts src/main/runtime/orchestration/db/lifecycle-transition-boundary.test.ts src/main/runtime/orchestration/db/attempt-outcome-projection.test.ts src/main/runtime/orchestration/r1-identity-migration.test.ts` — **4 files, 17 tests passed**.
- `pnpm test src/main/runtime/rpc/orchestration-commit-notify-characterization.test.ts src/main/runtime/rpc/terminal-prompt-delivery-receipt.test.ts` — **2 files, 14 tests passed**.
- Federation/release focused suite — **4 files, 65 tests passed**.
- Fleet/capability focused suite — **3 files, 19 tests passed**.
- `pnpm tc:node` — passed.
- `git diff --check` — passed.
- Broad changed-test invocation: **235 passed, 1 failed** in
  `src/cli/handlers/orchestration-worker-cli.test.ts`; the failure was the inherited Orca dev
  environment making `isDevCliInvocation()` true while the test expects `devMode: false`. Re-running
  that file with `ORCA_USER_DATA_PATH=` and `ORCA_DEV_CLI_INVOCATION=0` passed (11/11), so this is a
  test-environment isolation issue rather than a newly introduced worker-start contract failure.
