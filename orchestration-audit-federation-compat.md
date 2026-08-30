# Federation / SSH / mixed-version complexity audit

Scope: read-only review of federation and SSH execution-boundary paths in
`4a32d073fa` and their focused tests. No tracked source files were changed.

## Findings

### F1 — Keep: execution-host authority and peer pinning are implemented

Federated reads, stop, release, fleet snapshots, and relay pull/ack/import all
resolve the saved peer fingerprint and pass the resolved environment's pairing
revision as a fence (`src/main/runtime/rpc/methods/orchestration-worker-observation.ts:172-194`,
`src/main/runtime/rpc/methods/orchestration-federated-worker-read.ts:32-68`,
`src/main/runtime/orchestration/federation-sync.ts:63-90,156-199`). A re-paired
environment is rejected before an operation can target the wrong execution host.
Host-side attachment methods authenticate the Run-home fingerprint before
touching a terminal (`src/main/runtime/rpc/methods/orchestration-federation-attachment-observation.ts:4-17`),
and process identity is checked against the persisted pane/incarnation before
observation or close (`.../orchestration-federation-attachment-observation.ts:37-51`).
Focused regressions cover changed peer, pairing fences on every call, and stale
home observation fences (`orchestration-federated-transport-safety.test.ts:28-137`,
`orchestration-federated-fleet-snapshot.test.ts:62-145`). Keep this complexity;
these are concrete wrong-host and wrong-process failure modes.

### F2 — Keep: SSH contact loss remains `unverifiable`

`inspectRemoteAttachment` treats a missing/unknown host liveness verdict as
`unverifiable` and only an explicit host verdict yields `exited`
(`src/main/runtime/rpc/methods/orchestration-federation-attachment-observation.ts:53-75`).
The host release/stop code refuses to report a settled close when the PTY kill
was not confirmed (`src/main/runtime/rpc/methods/orchestration-federation-control.ts:215-264`).
The real-host tests exercise provider loss, old peers without verdict fields,
natural host exit, and unconfirmed close (`orchestration-federation-liveness-verdict.test.ts:145-355`).
This directly satisfies `docs/reference/ssh-execution-boundary.md` and should not
be simplified into `connected === false` heuristics.

### F3 — Keep: remote transcript reads do not fall through to desktop files

`readExactWorkerOutput` requires a registered SSH filesystem provider and returns
`remote_capability_unavailable` when the provider or attested path is absent
(`src/main/runtime/rpc/methods/orchestration-worker-output.ts:39-55`). The remote
reader only calls the provider with the hook-attested path and has a bounded
range/whole-file fallback (`src/main/runtime/orchestration/worker-transcript-read.ts:46-79`,
`worker-transcript-remote-read.ts:17-116`). Federated old peers are fenced to
terminal-only output and reject transcript cursors rather than silently changing
source (`orchestration-worker-legacy-federated-read.ts:17-47`). Keep; this is an
authority/security fix for same-path local lookalikes, not speculative handling.

### F4 — Simplify timing: fleet's five-second budget is not hard

Fleet sets a 5,000 ms total deadline and 3,000 ms per-host timeout
(`src/main/runtime/rpc/methods/orchestration-federated-fleet-snapshot.ts:14-17,40-57`),
but `OrchestrationPeerCapabilityCache.resolve` may retry once when the probe
observes a changed runtime epoch (`src/main/runtime/orchestration/orchestration-peer-capability-cache.ts:58-112`).
The retry receives the same `timeoutMs` computed before the first probe, so two
3-second status probes can consume ~6 seconds before the snapshot call (which is
then given a 1 ms minimum timeout). This violates the advertised total budget
under a fast peer restart. Pass the remaining deadline into capability probes or
disable stale-epoch retry for fleet reads; add a fake-timer regression asserting
the host call sequence stays within `FLEET_TOTAL_TIMEOUT_MS`.

### F5 — Simplify timing: relay page recursion has no total deadline

`syncFederatedDispatchPages` allows six 50-item pages
(`src/main/runtime/orchestration/federation-sync.ts:23-24,194-207`), each with
15-second pull/ack/import timeouts (`.../federation-sync.ts:76-90,156-199`). A
large backlog can therefore keep one dispatch sync in flight for roughly 90
seconds; overlapping syncs are coalesced by `OrcaRuntimeService`, so this can
delay newer lifecycle reports. The page cap is useful back-pressure, but carry a
single deadline through recursive pages (or lower per-page timeout) and add a
test that a six-page slow backlog respects that deadline. This is a timing
simplification, not an authority blocker.

### F6 — Defer (compatibility infrastructure): no real old/new federation wire harness

The focused federation tests model old peers by deleting capability strings or
mocking `method_not_found` (`orchestration-federation-output.test.ts:699-748`,
`orchestration-federation-liveness-verdict.test.ts:272-281`), while the actual
cross-version harness only covers terminal stream and structured agent-session
surfaces (`docs/reference/remote-wire-compatibility.md:45-63`). It does not run
released and current federation RPC/relay implementations against each other,
so required-field changes, zod stripping, relay payload semantics, or host
published-content drift could pass current tests. Keep the explicit capability
fallbacks now, but defer removal/expansion until a two-build federation/relay
journey covers start, pull/ack/import, worker read, fleet, and release; this is
an infrastructure gap rather than evidence that the current branch targets a
speculative user edge.

## Regression coverage run

```
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/runtime/rpc/methods/orchestration-federated-transport-safety.test.ts \
  src/main/runtime/rpc/methods/orchestration-federated-fleet-snapshot.test.ts \
  src/main/runtime/orchestration/orchestration-peer-capability-cache.test.ts \
  src/main/runtime/rpc/methods/orchestration-federation-output.test.ts
```

Result: 4 files, 35 tests passed (66.8 s). No tracked edits were made.

## Classification

Keep F1–F3 (proven execution-boundary and mixed-version safety); simplify F4–F5
(timing budgets); defer F6 (real cross-version federation harness). No blocking
authority defect was found in the reviewed federation/SSH paths.
