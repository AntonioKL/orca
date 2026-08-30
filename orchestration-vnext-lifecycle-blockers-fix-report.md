# Orchestration vNext lifecycle blocker fix

## Outcome

- Exact-authority `worker_done` reports now settle a `start_unknown` worker after reconnect. The blocked Task is atomically re-armed, then the Task, Dispatch, and worker settle through guarded lifecycle transitions with receipts.
- `createGate` now moves its Task to `blocked` through `transitionLifecycleWithDb` in the existing savepoint.
- Context-only stop/abandon now moves the Dispatch to `failed` and, when current, its Task to `blocked` through `transitionLifecycleWithDb` in the caller transaction.
- The direct-write ratchet covers decision-gate creation and context-only dispatch release.

## Regression coverage

- Exact pane/process authority and retained capability after `start_unknown`, with successful Task/Dispatch/worker settlement and receipt assertions.
- Decision-gate Task receipt and rollback of the gate, Dispatch, Task, and receipts when receipt insertion fails.
- Context-only stop/abandon Dispatch and Task receipts, plus rollback when receipt insertion fails.

## Verification

- Focused lifecycle suite: 4 files, 48 tests passed.
- Core orchestration DB and worker-dispatch suites: 73 tests passed.
- `pnpm tc:node`: passed.
- `pnpm run check:code-quality:changed`: passed with zero new findings.
- `git diff --check`: passed.
- `orchestration-worker-release.test.ts`: 40 passed, 1 pre-existing/unrelated failure. The test expected `closed_exited_terminal` but observed `closed_agent_terminal`; the files changed for this lifecycle fix do not touch worker-release process-action selection.
