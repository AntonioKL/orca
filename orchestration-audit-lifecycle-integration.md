# Lifecycle/identity/liveness integration audit

Scope: independent review of the current worktree diff against
`orchestration-vnext-implementation-audit.md` and the accepted lifecycle/R3c
reports. No source files were changed.

## Findings

### L1 — High: lifecycle writer centralization is incomplete and transitions are unconstrained

The new `transitionLifecycleWithDb` helper only checks the current state against
the caller's `from` list; it does not enforce a legal transition graph. The
public `recordWorkerStage` therefore accepts arbitrary `state` values and can
move a terminal worker backwards (for example `succeeded -> ready`) while
appending a plausible receipt (`src/main/runtime/orchestration/db/lifecycle-transition.ts:66-113`,
`db/worker-dispatch/worker-dispatch-stage.ts:6-59`). More importantly, several
production lifecycle writers still bypass the helper: `markWorkerStartUnknown`
directly updates worker/dispatch/task state (`db/worker-dispatch/worker-dispatch-outcome.ts:102-130`),
`settleActiveDispatchesForTask` and `failDispatch` directly update dispatch/task
projections (`db/dispatch-context/dispatch-completion.ts:40-56,105-177`), and
federated start reconciliation has direct updates (`db/worker-dispatch/federated-worker-start-reconcile.ts:28-105`).
These paths produce missing or synthetic `from_state` receipts and leave
projection/receipt divergence, violating P3's “every lifecycle writer” gate.

**Impact:** stale/late stop, retry, or remote-start events can revive or settle
the wrong projection; replay/audit cannot reconstruct the actual transition.
Block until all writers use a guarded legal-transition primitive (or are
explicitly schema/migration exceptions), with rollback and direct-update ratchet
tests.

### L2 — High: local fleet rows without `host_scope` are classified as remote

`projectHost` returns `{kind: 'remote', id: 'unknown'}` whenever a worker has a
resource but no `hostScope` (`src/shared/orchestration-fleet-projection.ts:197-207`).
Normal local worker authority calls leave `host_scope` null unless a caller
supplies it (`db/worker-dispatch/worker-dispatch-authority.ts:50-61,120-151`).
`projectLiveness` then treats that row as remote and rejects any status without a
`connectionId` as `unverifiable` (`orchestration-fleet-projection.ts:145-153`).
Thus ordinary local workers can show `host=remote/unknown` and lose fresh local
liveness evidence. The projection tests only cover an explicit local hostScope,
not the production-null case.

**Impact:** false `unverifiable`/stale attention and incorrect host routing for
local and folder-workspace workers. Block fleet promotion until null host scope
is represented as local (or every local authority write always stamps a typed
local scope) and a regression test covers it.

### L3 — High: remote attachment observation can infer exit from relay loss

`inspectRemoteAttachment` documents that a dropped relay is not a death
certificate, but when `getTerminalLivenessVerdict()` is absent/null it returns
`exited` solely from `terminal.connected === false`
(`src/main/runtime/rpc/methods/orchestration-federation-control.ts:281-295`).
The same fallback exists in local observation, but federation is the execution
host boundary where contact loss must remain `unverifiable`. An older/mixed
runtime or a provider that cannot produce the verdict can therefore make
`federationShow`, fleet projection, archive reads, and release/stop treat relay
loss as process exit.

**Impact:** unsafe remote stop/release and false completion/liveness after SSH or
relay loss. Block remote promotion until null/unknown verdict maps to
`unverifiable` (only an explicit host exit maps to `exited`), with an old-peer
fixture.

### L4 — Medium: federated release result is not reflected in the home projection

The new home-side `releaseFederatedWorker` returns the execution-host receipt
but never updates the home `worker_dispatches`, `dispatch_contexts`, or
`federated_dispatches` rows (`src/main/runtime/rpc/methods/orchestration-federated-worker-release.ts:14-91`).
The remote handler only marks its own attachment stage (`orchestration-federated-worker-release-host.ts:65-74`).
After a confirmed remote release, the home worker-list still has the prior
state/terminal projection (often a handle with no Resource and `retained`), so a
subsequent query can prescribe inspection/release again despite a successful
release receipt.

**Impact:** split-brain cleanup state and repeated operator actions; at minimum
the result must carry a durable home receipt or update the federated projection
idempotently, preserving `release_unknown` on ambiguous relay failure.

## Verification

Passed focused tests:

```
pnpm test src/main/runtime/orchestration/db/attempt-outcome-projection.test.ts \
  src/main/runtime/orchestration/db/lifecycle-transition.test.ts \
  src/main/runtime/orchestration/r1-identity-migration.test.ts \
  src/main/runtime/orchestration/orchestration-worker-dispatch-db.test.ts
# 4 files, 29 tests passed

pnpm test src/shared/orchestration-fleet-projection.test.ts \
  src/main/runtime/rpc/methods/orchestration-federation-liveness-verdict.test.ts \
  src/main/runtime/orchestration/orchestration-db-retention-pagination.test.ts
# 3 files, 26 tests passed

pnpm tc:node
# passed
```

## Verdict

**BLOCK.** The new identity/observation fixtures are useful and the focused
tests pass, but L1–L3 violate explicit vNext safety gates and can produce
incorrect lifecycle or remote liveness facts in production; L4 leaves remote
cleanup projection inconsistent.
