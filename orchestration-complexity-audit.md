# Orchestration-v3 complexity audit

Scope: read-only audit of activation/recovery, cold-park mailbox delivery,
federation/SSH authority, mixed-version behavior, and transcript/terminal-read
paths at `4a32d073fa`. Existing untracked audit files and five unrelated tracked
changes were preserved; no tracked source edits were made.

## Executive verdict

Most of the added state machines are justified by concrete failure modes: the
execution host remains authoritative, lifecycle recovery is transactional, and
mailbox/output reads are fenced by process/session identity. Two issues should
block promotion: the gated activation callback ignores `providesInitialSurface`,
and federation settlement mode is selected from persisted attachment protocol
even after a remote runtime can restart at an older capability level. Fleet and
relay time budgets are safe in outcome vocabulary but not budget-compliant under
retry/backlog; simplify or measure them before claiming latency guarantees.

## Findings

### A1 — Block: async activation can create an unwanted shell

The synchronous activation path honors the caller's non-terminal-surface opt-out
(`src/renderer/src/lib/worktree-activation.ts:274-287`). The gated callback instead
always invokes `ensureWorktreeHasInitialTerminal(..., { reseedEmptiedWorkspace: true })`
(`src/renderer/src/lib/worktree-activation.ts:257-269`), and the folder callback
does not forward the option at all (`:147-160`). When inventory hydration is in
flight, a file/diff navigation with `providesInitialSurface: true` can therefore
reseed a closed-last-terminal workspace after the gate resolves. Existing tests
prove the synchronous opt-out for worktrees and folders
(`src/renderer/src/lib/worktree-activation-emptied-workspace-reseed.test.ts:83-96,227-238`)
and gate hydration ordering (`src/renderer/src/lib/worktree-agent-activation-gate.test.ts:159-215`),
but not their combination. Add an async gated test for both workspace shapes that
holds inventory unresolved, activates with `providesInitialSurface: true`, resolves
to `empty`, and asserts the tab row remains empty; preserve the option through the
callback. This is a user-visible regression, not a speculative edge.

### A2 — Keep: lifecycle start-unknown and direct-write fixes are evidence-backed

Worker reports explicitly reconnect a blocked Task when its worker is
`start_unknown`, then settle Dispatch/Task/Worker through the lifecycle boundary
(`src/main/runtime/orchestration/db/dispatch-context/worker-report-settlement.ts:108-121,198-260`).
Start failures conservatively persist `start_unknown` (`src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-outcome.ts:112-154`).
Decision-gate and context-only release paths use `transitionLifecycleWithDb`, and
the boundary ratchet covers them (`src/main/runtime/orchestration/db/decision-gates/decision-gate-store.ts:84-90`,
`src/main/runtime/orchestration/context-only-dispatch-release.ts:39-75`,
`src/main/runtime/orchestration/db/lifecycle-transition-boundary.test.ts:5-23`).
Keep; earlier reviews that called start-unknown completion a blocker are stale at
this commit.

### A3 — Keep / simplify: cold-park mailbox mechanism vs fixed delay

Pointer delivery durably stages the pointer and delayed Enter, then revalidates
exact PTY, process incarnation, mailbox ownership, writability, and live idle state
before writing (`src/main/runtime/orchestration/mailbox-pointer-stage.ts:75-180`,
`src/main/runtime/orchestration/mailbox-pointer-submit.ts:62-153`). Restart recovery
settles conservatively without replaying an ambiguous Enter, and focused tests cover
delayed write, same-incarnation idle, explicit-check races, and duplicate suppression
(`src/main/runtime/orchestration/mailbox-pointer-submit.test.ts:82-153,325-381`,
`src/main/runtime/orchestration-mailbox-notification-consistency.test.ts:554-610`).
Keep this complexity: it protects real duplicate/lost-mail cases. The 500 ms
pointer-to-Enter constant (`mailbox-pointer-delivery.ts:17-23`) has no production
latency evidence; measure agent startup distributions or make the delay adaptive
before treating it as a contract (simplify/defer, not a correctness block).

### A4 — Keep: SSH/federation authority and liveness vocabulary

Remote attachment observation uses the execution host's verdict and maps absent
contact/verdict to `unverifiable`, never `exited`
(`src/main/runtime/rpc/methods/orchestration-federation-attachment-observation.ts:21-75`).
Federated operations pin peer fingerprint and pairing revision before every call
(`src/main/runtime/rpc/methods/orchestration-worker-observation.ts:172-194`,
`src/main/runtime/orchestration/federation-sync.ts:63-90,154-199`); release retains on
identity uncertainty. This matches `docs/reference/ssh-execution-boundary.md` and
is covered by liveness/transport safety suites. Keep; local terminal-connected
heuristics must not replace host authority.

### A5 — Block: settlement capability is stale across a remote downgrade/restart

`syncFederatedDispatchPages` decides `supportsLifecycleSettlement` solely from the
persisted attachment protocol (`src/main/runtime/orchestration/federation-sync.ts:75-86`),
and host ACK validation does the same (`src/main/runtime/orchestration/db/federation/federation-relay-ack.ts:80-99`).
The peer capability cache observes runtime epochs, but federation sync does not use a
status capability probe for this decision. A v3 attachment that survives a remote
restart/downgrade can make the new home send `replayUnacknowledged` and settlement
payloads to an old parser; zod strips those unknown fields
(`src/main/runtime/rpc/methods/orchestration-federation-relay.ts:13-18,20-42`),
so the remote may ACK relay rows without applying the lifecycle settlement or may
return a non-replayed sequence that the v3 home interprets under the wrong mode.
This violates the mixed-version rule that behavior changes require capability
negotiation (`docs/reference/remote-wire-compatibility.md:25-29,61-76`). Existing
tests cover protocol at attach time and epoch cache invalidation, but not one
attachment whose runtime capability changes. Add a two-runtime regression that
persists protocol 3, reports a new epoch with no settlement capability, and asserts
safe legacy mode (or `unverifiable`/retry without settlement mismatch). Block until
that scenario is handled or explicitly fenced.

### A6 — Simplify/defer: fleet and relay timing are not justified guarantees

Fleet advertises a 5 s total / 3 s host budget with concurrency four
(`src/main/runtime/rpc/methods/orchestration-federated-fleet-snapshot.ts:16-18,49-99`),
but capability resolution may retry once after an epoch race using the original
3 s probe timeout. Two probes can consume about 6 s before the snapshot call; pass
the remaining deadline into retries and add a fake-timer budget test. Relay sync
recurses through six 50-item pages with independent 15 s pull/ACK/import timeouts
(`src/main/runtime/orchestration/federation-sync.ts:23-24,79-90,154-165,194-207`),
allowing roughly 90 s and delaying fresh lifecycle reports. Carry one deadline
through pages or lower per-page timeout. These paths fail closed as host-unavailable
or unverifiable, so classify as simplify/defer timing work rather than authority
blocks.

### A7 — Keep: transcript/terminal reads are source- and host-fenced

Exact reads require a hook-attested transcript path and SSH filesystem provider;
desktop filesystem lookup is not attempted for remote sessions
(`src/main/runtime/orchestration/worker-transcript-read.ts:62-78`,
`src/main/runtime/rpc/methods/orchestration-worker-output.ts:39-71`). Local and remote
readers revalidate inode/size, boundary checkpoints, and provider identity
(`worker-transcript-local-read.ts:46-75,87-145`,
`worker-transcript-remote-read.ts:82-111`). Cursors pin dispatch/source identity,
and legacy federated peers reject transcript cursors rather than silently switching
to terminal output (`src/main/runtime/rpc/methods/orchestration-worker-legacy-federated-read.ts:17-47`).
Terminal fallback is explicitly `sourceExact:false/contentComplete:false`
(`src/main/runtime/rpc/methods/orchestration-worker-output.ts:211-220`). Keep these
guards; they address wrong-host and stale-process user failures.

### A8 — Simplify/defer: clipping metadata and pathological scans

Local initial transcript reads set `limited: page.hasMore` but return no explicit
non-pageable clipping warning (`src/main/runtime/orchestration/worker-transcript-local-read.ts:53-75`),
unlike the remote bounded path (`worker-transcript-remote-read.ts:205-213`). Add a
regression asserting `contentComplete`, `clipping`, and warning parity, plus CLI
`terminal read --screen` old-host formatting coverage. Defer stronger source hashing
for same-size rewrites with coarse mtime and a cap for files containing only malformed
records; those are theoretical and lack user-impact evidence.

## Regression suites and evidence

The focused audit run passed 8 files / 55 tests, covering mailbox cold-park and
restart recovery, lifecycle guards, peer capability cache, federation output and
transport safety, local/remote transcript reads, archive reads, and terminal-read
cursor behavior. Federation/SSH sub-suite independently passed 4 files / 35 tests;
transcript/terminal sub-suite passed 4 files / 34 tests. No tracked source edits were
made. Before release, add the A1 gated-surface test and A5 persisted-protocol/runtime-
capability downgrade test; use fake timers for A6 budget assertions and a real
two-build federation/relay harness (deferred infrastructure) before removing fallbacks.

## Classification summary

| Area | Keep | Simplify / defer | Block |
| --- | --- | --- | --- |
| Activation / recovery | lifecycle correction and recovery fencing | 500 ms delay measurement | A1 async `providesInitialSurface` regression |
| Cold-park mailbox | durable pointer + incarnation revalidation | adaptive delay / remote repark test | — |
| Federation / SSH | host authority, peer pinning, `unverifiable` | fleet/relay deadlines; two-build harness | — |
| Mixed-version settlement | explicit fallbacks elsewhere | — | A5 capability stale after downgrade |
| Transcript / terminal read | provider/path/source fences, cursor identity | clipping metadata; pathological scan tests | — |
