# Technical review: Orca orchestration vNext implementation audit

## Scope and verdict

This review compares `orchestration-vnext-implementation-audit.md` with local
`main` (`aab6464a6a`). The orchestration files inspected are unchanged between
that revision and this worktree's HEAD. Evidence below therefore names the
worktree paths and current line numbers, but the findings describe `main`.

The proposed direction—durable facts, explicit uncertainty, execution-host
authority, and additive mixed-version rollout—is sound. The plan is not yet
implementation-ready, however. Several premises are stale, two existing
correctness bugs are hidden by the proposed abstractions, the DAG permits schema
work before its identities are defined, and the promised consolidation PR is too
large to be a safe migration or rollback unit.

The most important corrections are:

1. Treat the existing immutable Dispatch ID as the Attempt ID and the existing
   terminal-resource ID as the Resource ID. Add only missing creator, role,
   retry, and endpoint-incarnation facts.
2. Fix archive/liveness truth and commit-versus-notify recovery before building
   lifecycle or fleet projections. Both can currently produce misleading or
   duplicated results.
3. Split mailbox persistence, PTY pointer delivery, prompt submission, and
   lifecycle settlement into separate receipt domains. They are not one
   monotonic state machine.
4. Make migration/skew tests and negotiated remote capabilities prerequisites,
   not a final P7 exercise.
5. Ship independently merged additive slices and a small promotion PR. Do not
   recombine all implementation branches into one feature PR.

Focused existing coverage was run while reviewing the delivery claims:

```text
pnpm test \
  src/main/runtime/orchestration-message-delivery-identity.test.ts \
  src/main/runtime/orchestration-mailbox-notification-consistency.test.ts \
  src/main/runtime/rpc/methods/orchestration-ask.test.ts \
  src/main/runtime/rpc/methods/orchestration-recipient-routing.test.ts \
  src/main/runtime/rpc/terminal-agent-prompt-send.test.ts \
  src/main/runtime/agent-prompt-submission-verification.test.ts
```

Result: 69 passed, 1 skipped. This validates current behavior only; it does not
close the crash seams or missing cases identified below.

## Findings

### F1 — Critical: archived output can falsely report `exited`

**Plan claim.** P0/P4 promise that no relay loss, timeout, or uncertain close is
reported as `exited`, and P5 treats archive reads as a reliable released-worker
source.

**Current code.** `orchestration.workerRead` routes resources in all three
states—`releasing`, `unknown`, and `released`—straight to the archive without a
fresh terminal observation
(`src/main/runtime/rpc/methods/orchestration-worker-control.ts:210-220`). Both
archive result shapes hard-code terminal state to `exited`
(`src/main/runtime/rpc/methods/orchestration-worker-archive-read.ts:98-106` and
`:201-217`). Release commits `releasing` before awaiting the close and stores
`unknown` when `ptyKilled` is false
(`src/main/runtime/rpc/methods/orchestration-worker-release-completion.ts:188-227`).
The existing unknown-release regression reads the archive but does not assert
liveness (`src/main/runtime/rpc/methods/orchestration-worker-release-recovery.test.ts:166-193`).

**Correction.** Make archive provenance and process liveness orthogonal. Only a
host-confirmed close may project `exited`; `releasing` requires a current
execution-host observation and `unknown` projects `unverifiable`. Put this
characterization/fix before P4 and before any fleet projection consumes the
result.

### F2 — Critical: P2 combines three different, non-monotonic contracts

**Plan claim.** The sequence `recorded → routed → endpoint_delivered →
terminal_queued → provider_submitted → turn_started → ...` is presented as one
delivery receipt chain.

**Current code.** Mail insertion is durable
(`src/main/runtime/orchestration/db/messages/message-insert.ts:26-54`). The PTY
pointer path marks `messages.delivered_at` after pointer _text_ is accepted
(`src/main/runtime/orchestration/mailbox-pointer-delivery.ts:181-243`) and only
writes Enter 500 ms later (`mailbox-pointer-delivery.ts:253-270` and
`mailbox-pointer-submit.ts:57-84`). A crash or failed Enter can therefore leave a
legacy `delivered_at` that proves neither endpoint submission nor provider
acceptance.

**Correction.** Define separate facts:

- mail: `recorded`, `mailbox_routed`, `delivery_issued`, `consumer_acked`;
- advisory nudge: `pointer_text_written`, `submit_written|ambiguous|failed`;
- agent prompt: `terminal_bytes_written`, `submission_observed`, `turn_started`;
- worker lifecycle: report/settlement receipts owned by P3.

Never backfill legacy `delivered_at` as a higher receipt stage. These domains may
be correlated by IDs but must not be reduced as one total order.

### F3 — Critical: the real duplicate-send hole is commit versus notification

**Plan claim.** “Ordinary replies are not idempotent,” so P2 should add an
idempotency key.

**Current code.** The CLI already assigns every orchestration mutation a UUID
request ID (`src/cli/runtime/client.ts:69-95`), `orchestration.reply` is a durable
mutation (`src/shared/orchestration-rpc-contract.ts:18-39`), and the mutation
executor replays matching completed receipts
(`src/main/runtime/rpc/orchestration-mutation-executor.ts:23-115`). Question
answers also have transactional idempotency/conflict detection
(`src/main/runtime/orchestration/db/questions/question-threads.ts:73-143`).

The actual gap is later: single send commits the message and then performs a
fallible in-memory notify without first completing the mutation receipt
(`src/main/runtime/rpc/methods/orchestration.ts:684-803`). Generic reply marks
the original read, inserts the reply, and then notifies
(`orchestration.ts:1447-1459`). If notify throws, the generic executor deletes
the pending receipt, so an exact retry can insert a duplicate. Group send
already shows the intended ordering—complete the receipt before notify
(`orchestration.ts:863-895`)—and has a regression test
(`orchestration-recipient-routing.test.ts:517-549`).

**Correction.** Reuse the mutation ledger. Atomically persist the message,
settlement result where applicable, a nudge-outbox record, and a completed
mutation receipt. Notification is best-effort redrive after durable authority;
its failure must replay the recorded result rather than erase the receipt. A new
request ID remains an intentional new message.

### F4 — High: the asserted `check --wait` race is not established on the

current synchronous path

Run `check` performs its final synchronous delivery read and immediately calls
`waitForMessage` with no intervening `await`
(`src/main/runtime/rpc/methods/orchestration.ts:1007-1055`). Waiter registration
happens synchronously inside the Promise constructor
(`src/main/runtime/orca-runtime.ts:35605-35647`). With better-sqlite3 and RPC
handlers on the same JS event loop, an ordinary same-runtime insert cannot
interleave at the seam described by the plan. Dispatch and direct-mail paths
must also be characterized rather than assumed.

**Correction.** Add deterministic hooks at actual asynchronous boundaries—paged
routing, federation/connection replacement, and notify failure—and prove a
failing case before adding a durable mailbox epoch. Register-then-recheck with
cancellation is sufficient if a real local seam exists. Prioritize the proven
commit/notify crash gap from F3.

### F5 — High: restart wakeup wording would violate restored-status safety

The runtime already scans undelivered mail and schedules pointers on
initialization (`src/main/runtime/orca-runtime.ts:4551-4566` and
`:35545-35573`), then redrives on a fresh live-idle observation
(`orca-runtime.ts:7306-7321`). It intentionally refuses to type into a merely
restored idle snapshot; the two-launch regression explains the stale-draft and
wrong-process hazard (`tests/e2e/orchestration-idle-mail-restore.spec.ts:1-20`
and `:148-179`).

**Correction.** The acceptance contract is “mail survives restart and is nudged
after a post-restart live observation or explicit check,” not “wakes without a
heartbeat.” A durable row cannot wake an offline process, and a stale restored
snapshot must never authorize Enter.

### F6 — High: terminal prompt idempotency is a new subsystem boundary

`terminal.send` is not an orchestration durable mutation. The CLI sends
`agentPrompt: true` (`src/cli/handlers/terminal.ts:105-117`), while the runtime
pastes bytes, presses Enter, and waits only for a new working sequence
(`src/main/runtime/orca-runtime.ts:19900-19978`). The verifier may throw
`agent_prompt_stalled` after the irreversible writes
(`src/main/runtime/agent-prompt-submission-verification.ts:17-40`). The RPC
schema carries neither a prompt request ID nor a wait contract
(`src/main/runtime/rpc/methods/terminal/unary-schemas.ts:82-111`), and the shared
result exposes only acceptance/bytes written
(`src/shared/runtime-terminal-contracts.ts:196`).

Changing `agent_prompt_stalled` into `queued_pending_turn` also changes existing
CLI success/exit semantics, so it is not an additive field-only change.

**Correction.** Add a narrowly scoped prompt-delivery ID bound to terminal,
process incarnation, and payload, guarded by a runtime capability. Separate
`terminal_bytes_written` from a later submission observation; `--wait-submit`
must observe the same request, never resend it. Keep raw keystrokes and
question-reply terminal writes outside this ledger. Old-host downgrade must be
explicit, not optimistic.

### F7 — High: draft protection is not independently implementable in P2

Both mailbox pointers and agent prompts write into the current composer and
later write Enter (`mailbox-pointer-delivery.ts:181-270` and
`orca-runtime.ts:19900-19978`). Provider-neutral idle does not prove that the
composer is empty. No current check proves an existing human draft is absent.

**Correction.** Either make the minimal provider/draft capability slice of P5 a
prerequisite or disable auto-Enter whenever composer emptiness is unproven. The
plan cannot promise draft preservation while declaring P2 parallel with all
provider work.

### F8 — High: P1 duplicates identities that already exist

`dispatch_contexts.id` is already the immutable identity created on each worker
start (`src/main/runtime/orchestration/db/schema/create-graph-tables-sql.ts:120-143`)
and keys `worker_dispatches.dispatch_id`
(`src/main/runtime/orchestration/db/schema/create-core-tables-sql.ts:112-130`).
Retries validate `retryOf` and create a new dispatch ID, although the retry edge
is not persisted (`src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-start.ts:65-89`).
`worker_terminal_resources.id` is already an immutable resource identity with
owner history, process incarnation, host scope, and ownership/release state
(`create-core-tables-sql.ts:132-167`).

Tasks already carry `parent_id`, and dispatches/remote attachments already carry
depth (`create-graph-tables-sql.ts:95-118`, `:120-143`, and
`src/main/runtime/orchestration/db/dispatch-depth.ts:53`).

**Correction.** Formally alias Dispatch ID as Attempt ID and keep the existing
Resource ID. Persist `retry_of_dispatch_id`, creator-dispatch identity, and role;
add only the endpoint/incarnation facts not already represented. Preserve the
canonical parent/depth fields. Do not introduce parallel Attempt/Resource IDs or
backfill unknown legacy provenance with guessed ownership.

### F9 — High: P3 statuses are not additive schema changes

Task status, dispatch status, worker state, resource ownership, and resource
release state are closed SQLite `CHECK` constraints
(`create-graph-tables-sql.ts:95-143` and `create-core-tables-sql.ts:112-155`).
Adding `outcome_unknown`, `finished_unverified`, `cancelled`, or `superseded` to
those columns requires rebuilding tables; the existing migration machinery
demonstrates such a rebuild (`src/main/runtime/orchestration/db/schema/migrate-v2-v12.ts:5-140`).

**Correction.** Initially store additive observation/receipt facts in new tables
or nullable/defaulted columns, then project the richer vocabulary without
widening the legacy enums. If an enum widening is still needed, make it a
separate compatibility migration with old-runtime write tests and an explicit
rollback window.

### F10 — High: “append-only transitions or equivalent” is too vague for the

number of lifecycle writers

Worker report settlement, manual task update, stop, missing-terminal recovery,
and federated paths all write lifecycle state. `recordWorkerStage` directly
updates worker stage/state without compare-and-swap
(`src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-stage.ts:19`).
Adding a transition table beside those writers would produce a partial audit log
rather than an authority. `recordWorkerStage` is a concrete example: it reads the
current row and then performs an unfenced update
(`src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-stage.ts:19-45`).

**Correction.** First route every lifecycle mutation through transaction-neutral
transition primitives. The primitive must validate the old state, update legacy
projection fields, and append its receipt in the same transaction supplied by
the caller. Add a ratchet test forbidding direct lifecycle `UPDATE`s outside
those modules and rollback-injection tests for each writer. Only then add the P3
reducer/projection.

### F11 — High: heartbeat age lacks a clock-domain contract

Local heartbeat time is the home database's message insertion time
(`src/main/runtime/orchestration/lifecycle-reconciliation.ts:168` and
`db/messages/message-insert.ts:31`). Federated relay import also carries a
worker-supplied `lifecycle.at`
(`src/main/runtime/orchestration/db/federation/federation-relay-import.ts:91`).
Computing age from mixed source clocks can turn clock skew into false liveness or
false death.

**Correction.** Persist source observation time separately from execution-host
receive time and home-host receive time. Freshness is computed in the authority
host's clock domain and combined with the canonical connection verdict. Never
rewrite `live`/`unverifiable`/`exited`, which already exists in
`src/shared/pty-liveness-verdict.ts:1`, into a second vocabulary.

### F12 — High: the lease invariant is impossible and crosses host authority

The consolidation gate “No active Attempt lacks an owner/resource lease” is
false during legitimate startup and for supported topologies. A starting worker
exists before authority attach
(`worker-dispatch-start.ts:103-117` and
`src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-authority.ts:104`).
Context-only/unsupervised dispatches may never own a terminal resource. A
federated home DB intentionally has no local terminal resource because the
worker host owns it (`src/main/runtime/orchestration/db/worker-terminal/worker-terminal-resource-store.ts:12`
and `src/main/runtime/rpc/methods/orchestration-worker-release.ts:34`).

**Correction.** Use this invariant instead: after local authority attachment,
each supervised local dispatch has exactly one execution-host terminal resource
or an explicitly external resource. Pre-attach, context-only, and federated-home
dispatches have typed absence/remote attachment, never a fabricated local lease.

### F13 — High: P4's baseline description collapses three different operations

Only release archives before close
(`src/main/runtime/rpc/methods/orchestration-worker-release-completion.ts:169-216`).
Local stop closes directly without archiving
(`src/main/runtime/rpc/methods/orchestration-worker-stop.ts:140-170`). Abandon is
a DB-only state change that neither closes nor archives and can retain a live
resource (`src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-abandon.ts:54-76`).
Federated stop likewise closes remotely without archive
(`src/main/runtime/rpc/methods/orchestration-federation-control.ts:127-180`), and
federated release is currently unsupported
(`src/main/runtime/rpc/methods/orchestration-worker-release.ts:33-44`).

**Correction.** Specify stop, abandon, and release separately. Decide whether
stop must archive or return an explicit output-loss receipt. Abandon must retain
and expose readable live output. Remote archive-before-close is a later
capability-negotiated operation owned jointly by P4/P5/P7, not existing behavior.

### F14 — High: P4 risks reimplementing the current resource ownership system

The existing resource table already represents owner history, process/host
fencing, transferred/user/external ownership, retention reasons, and release
states (`create-core-tables-sql.ts:132-167`). Restart reconciliation already
operates those rows
(`src/main/runtime/orchestration/worker-terminal-release-reconciliation.ts:19`).

**Correction.** Extend `worker_terminal_resources` with optional retention
expiry/policy, recovery attempt counters, and pagination indexes. Do not create a
second terminal lease table or identity. Bulk cleanup must reuse the same
single-resource fenced transition and remain conservative for external,
user-owned, transferred, federated-home, and unverifiable resources.

### F15 — Critical: direct-SSH transcript reads violate the execution-host

boundary

The plan says remote/federated reads execute on the owning host and explicitly
puts “desktop-side SSH/WSL file reads” out of P5 scope. Worker session selection
filters status by connection ID
(`src/main/runtime/orca-runtime.ts:18821-18849`) but the selected session drops
that host identity (`src/main/runtime/orchestration/worker-provider-session.ts:12-33`).
`readWorkerTranscript` then resolves and opens the path in the client main
process (`src/main/runtime/rpc/methods/orchestration-worker-output.ts:37-50` and
`src/main/runtime/orchestration/worker-transcript-read.ts:53-69`). The resolver
explicitly works against the current main process's home/filesystem
(`src/main/native-chat/session-file-resolver.ts:21-25`). Existing support metadata
already says Model-A SSH local scanning is the wrong host
(`src/shared/native-chat-agent-support.ts:16-23`).

For a non-Windows absolute path, a same-path local lookalike may even be accepted
(`src/main/native-chat/host-readable-transcript-path.ts:115-137`). That can expose
unrelated local content as evidence for a remote worker.

**Correction.** Carry host scope/connection identity into provider-session
selection and transcript resolution. Direct SSH must use a negotiated remote
transcript-read capability or explicitly fall back with
`remote_capability_unavailable`; it must never probe a client-local path. This is
P5/P7 scope and a security boundary, not a deferred enhancement.

### F16 — High: WSL and SSH need different read contracts

Current WSL support intentionally performs guarded Windows-host UNC reads
(`src/main/native-chat/host-readable-transcript-path.ts:108-158` and `:179-201`),
and the session resolver uses that mechanism
(`src/main/native-chat/session-file-resolver.ts:98-123` and `:199-203`). Tests
characterize UNC translation
(`src/main/native-chat/session-file-resolver-wsl.test.ts:73-114`).

**Correction.** Define four separate routes: local/folder uses local main FS;
WSL uses guarded UNC on the Windows execution host; direct SSH uses a remote
capability; federation executes on the peer server. Assert that none falls
through to a different topology.

### F17 — High: “exact transcript captured at dispatch attach” is false

Provider session is selected on each read from the current in-memory status
snapshot (`orca-runtime.ts:18821-18849`); no session binding is persisted at
attach. Without a launch token, the process incarnation is copied into the
result rather than compared to a status-side incarnation
(`worker-provider-session.ts:27-33`), a behavior its tests accept
(`worker-provider-session.test.ts:24-45`). The returned content is also bounded:
50 messages, block count limits, response clipping, and text/tool clipping
(`src/main/runtime/orchestration/worker-transcript-payload.ts:4-10`, `:38-109`,
and `:143-203`).

**Correction.** Say “a bounded decoded projection from the currently selected
provider session/file.” Preserve the already exposed source, source identity,
provider, fallback, warnings, liveness, and archive fields
(`src/shared/orchestration-worker-output.ts:28-68`). Add orthogonal
`sourceExact`, `contentComplete`, and clipping reasons if needed. If durable
attach-time binding is desired, make it explicit P1/P5 schema fenced by
Attempt+Endpoint+process.

### F18 — Medium-high: archived terminal fallback discards provenance

Live fallback preserves `session_not_reported`, provider, missing-path, and parse
reasons (`orchestration-worker-output.ts:37-59` and `:163-177`). Archive capture
drops failed transcript reasons
(`src/main/runtime/orchestration/worker-output-archive.ts:56-79`), and archived
terminal results always report `fallbackReason: null`
(`orchestration-worker-archive-read.ts:201-217`).

**Correction.** Persist attempted transcript source, fallback reason, and
warnings in the existing terminal-tail archive. Do not claim an explicit reason
survives release until this is implemented and migration behavior is defined.

### F19 — High: an in-flight archive mirror cannot run in parallel with P1/P4

Existing archive identity is dispatch/resource/process based
(`orchestration-worker-archive-read.ts:74-85` and `:182-191`). A new mirror must
bind the final Attempt/Endpoint/Resource model and define quotas, retention,
cleanup, redaction, crash semantics, and process-replacement fencing.

**Correction.** Decoder/metadata characterization may begin after P0. Gate mirror
schema on the P1 identity decision and archive lifecycle on P4. Extend the
existing resource/archive identity rather than introducing a mirror-specific
Resource ID. If no concrete failure requires an in-flight mirror, omit it; the
current release snapshot and existing provider/terminal watchers should be
reused first (`src/main/native-chat/transcript-watch.ts:23-42` and terminal
subscription in `src/main/runtime/rpc/methods/terminal/terminal-subscribe-method.ts:11`).

### F20 — High: P6 cannot promise one host-routed query without P7

`workerList` already returns worker/dispatch/resource projections, including
unsupervised rows
(`src/main/runtime/orchestration/db/worker-terminal/worker-terminal-listing.ts:85-143`
and `src/main/runtime/rpc/methods/orchestration-worker-release.ts:143-166`). It is
unbounded and local. Federated show/read are per-dispatch calls, and read uses a
15-second timeout (`orchestration-worker-control.ts:159-192`). Naively observing
each remote row creates N+1 calls and serial timeout risk.

The renderer is not simply “polling lanes”: orchestration status is already
push-fed into indexed worktree maps
(`src/renderer/src/components/sidebar/worktree-agent-orchestration-index.ts:168-229`),
while the coordinator has a single 2-second tick over DB work
(`src/main/runtime/orchestration/coordinator.ts:35-55` and `:107-165`).

**Correction.** Introduce an early read-only durable fleet projection by
extending/composing `workerList`, then enrich it as facts land. Remote fleet
observation requires a P7 negotiated _batched per-host snapshot_ with concurrency
and total-time budgets, partial-host errors, stable pagination, and no transcript
bodies. Keep push status for live UI; name the exact old callers being retired.

### F21 — High: P7 is infrastructure for earlier slices, not a final gate

Federation already negotiates orchestration protocol/capabilities
(`src/shared/protocol-version.ts:44-55` and `:156-165`) and has a distinct durable
contiguous relay/ack protocol
(`src/main/runtime/orchestration/db/federation/federation-relay-enqueue.ts:10-175`
and `federation-relay-import.ts:44-129`). Avoiding a new stream opcode is not
enough: receipt and relay-content semantics are also wire contracts.

Old-peer structured output is probed on every read: method-not-found falls back
to legacy read (`orchestration-worker-control.ts:159-192` and
`orchestration-worker-legacy-federated-read.ts:31-45`). Total relay loss is
currently rethrown, not converted into a worker-read result
(`orchestration-worker-control.ts:179-182`).

**Correction.** Build old/new RPC and relay skew fixtures alongside the first
behavioral slice. Add a capability cache keyed by peer fingerprint/runtime epoch
with a narrow unsupported predicate. P6 may project a typed host-unavailable row
as `unverifiable`, but an individual worker-read should return a typed unavailable
error rather than inventing an observation.

### F22 — High: migration and rollback work is materially incomplete

`createTables()` runs before transactional version migration
(`src/main/runtime/orchestration/db/orchestration-db.ts:24-31`). Schema-skew repair
probes physical shape and can rewind version state
(`src/main/runtime/orchestration/orchestration-schema-version-skew.ts:91-116`).
Old binaries intentionally open future-schema DBs without running migrations
(`src/main/runtime/orchestration/db/schema/migrate.ts:7-24`). Consequently a new
non-null/no-default column, widened CHECK, mandatory trigger, or authoritative
epoch can break rollback or go stale while an old runtime writes.

**Correction.** Every schema slice must update fresh DDL, transactional
migration, version/skew probes, schema-version comments, reset/retention logic,
and old/new fixtures together. Use additive tables or nullable/defaulted columns.
On re-upgrade, reconcile new receipts from legacy authority rather than assuming
old code maintained them.

### F23 — High: atomic Task creation plus worker start is omitted

The companion `orchestration-issues.md` requests atomic Task creation + worker
start, but the matrix has no bounded slice for it. Current `workerStart` requires
an existing task (`src/main/runtime/rpc/methods/orchestration-workers.ts:48`), and
only starting-dispatch creation is atomic after that task lookup
(`worker-dispatch-start.ts:61-117`).

**Correction.** Add a distinct vertical slice after identity and mutation-ledger
hardening. It should create/reconcile Task + Dispatch + mutation receipt in one
transaction, then perform external side effects via the same recovery model as
worker start. Do not bury this API/product change in P3.

### F24 — Medium-high: several proposed items reimplement or over-scope existing

systems

- Cross-Run send routing already returns typed `recipient_run_mismatch` and
  `recipient_ambiguous` errors
  (`src/main/runtime/rpc/methods/orchestration-recipient-routing.ts:29-89` and
  `:120-145`). Pin these behaviors instead of adding a second auth layer.
- Current Run delivery already has one immutable outstanding batch and
  idempotent whole-batch ack
  (`src/main/runtime/orchestration/db/runs/run-delivery.ts:23-70` and `:125-175`).
  Per-message ack is a new negotiated contract with difficult old-client replay
  semantics, not a prerequisite without a demonstrated loss case.
- Provider aliases/support, resolver, decoder, lifecycle parsing, and passive
  watches already exist in `src/shared/native-chat-agent-support.ts:1-46`,
  `src/main/native-chat/session-file-resolver.ts:126-165`,
  `transcript-tail-reader.ts:36-50`, `transcript-turn-lifecycle.ts:23-34`, and
  `transcript-watch.ts:23-42`. Consolidate these maps into one exhaustive profile
  rather than building a parallel orchestration-only registry.

### F25 — High: “one consolidation PR” is an unsafe delivery unit

The plan proposes separately reviewable PRs, mixed-version support, schema
migrations, new delivery semantics, remote capabilities, and a fleet UI, then
recombines their branches into one consolidation PR. That maximizes rebase and
migration coupling and defeats incremental rollback.

**Correction.** Merge additive slices independently behind capabilities and
legacy projections. Run conformance continuously. Finish with a small promotion
PR that changes consumers/defaults. Retain compatibility shims for at least one
mixed-version release window and remove them only after telemetry proves disuse.

## Revised implementation DAG

```text
R0  Characterize current contracts and reuse canonical vocabulary
    ├─ Fix false-exited archive projection (F1)
    ├─ Reproduce/fix commit→notify recovery (F3)
    └─ Establish old/new DB, RPC, relay, and provider fixtures

R1  Identity decision and migration contract
    ├─ Dispatch == Attempt; retain existing Resource ID
    ├─ Add retry/creator/role and endpoint-incarnation facts
    └─ Fresh/upgrade/downgrade/skew tests

R2  Central lifecycle transition primitives (after R1)
    └─ All current writers dual-write receipts transactionally

In parallel after R0/R1:
    R3a Mail/outbox atomicity using existing mutation ledger
    R3b Provider capability consolidation and topology-safe reads
    R3c Early local-only read-only fleet projection for rollout parity
    R3d Atomic Task-create + worker-start vertical slice

After provider draft capability and endpoint identity:
    R4  Prompt-specific idempotency and submission observation

After R2:
    R5  Lifecycle reducer/projection and clock-domain-safe freshness
    R6  Existing-resource lease metadata, cleanup, and archive semantics

After remote capability fixtures exist:
    R7  Negotiated remote transcript/release/batched fleet slices

Last:
    R8  Fleet/attention UI promotion and bounded notification policy
```

P7-style conformance is continuous infrastructure beginning in R0, not a late
branch. An in-flight transcript mirror, partial ack, or richer enum migration is
admitted only after its specific failure case and mixed-version contract are
approved.

## Revised acceptance tests

### Identity and migration

1. A retry gets a new Dispatch/Attempt ID, persists `retry_of`, and a late report
   from the prior attempt cannot mutate the new attempt or Task settlement.
2. Pane remint, terminal reuse, process replacement, host mismatch, and spoofed
   payload identity all fail closed; the legitimate current incarnation passes.
3. Local, folder-workspace, context-only, unsupervised, SSH, WSL, and
   federated-home rows express resource presence or typed absence without
   fabricating a local lease.
4. Fresh vNext and upgraded vNext schemas are structurally equivalent. Exercise
   vCurrent → vNext → vCurrent → vNext, performing send/check/reply/start at each
   step, plus interrupted migration, partial/future schema, reopen, reset, and
   retention bounds.
5. Old runtime writes while new optional receipt tables are untouched; re-upgrade
   reconciles without treating absence as acknowledged/submitted.

### Mail, notification, and prompt delivery

1. Inject throw/crash after commit for Run send, Dispatch send, generic reply,
   worker-done settlement, and federated enqueue. Retrying the same request ID
   after DB reopen returns the same message/relay/result and produces exactly one
   durable side effect; changed payload conflicts; a new ID is a new message.
2. Crash after pointer text and before Enter. Legacy `delivered_at` must project
   only the legacy fact, never submitted/acknowledged. After reopen, redrive
   requires a fresh live-idle observation and never emits duplicate Enter.
3. Characterize insertion before final read, after waiter registration, during a
   paged/federated yield, on notification failure, and over socket/runtime
   replacement for Run, Dispatch, and direct mailbox paths. Add an epoch only if
   a real missed-event seam remains.
4. A pre-existing human draft in Claude, Codex, and unsupported-provider fixtures
   is preserved byte-for-byte; unproven emptiness yields
   `draft_unknown`/explicit-check rather than auto-Enter.
5. Prompt response loss after bytes/Enter followed by replay of the same prompt
   ID never writes again. Payload, terminal, or process-incarnation mismatch is
   a conflict. Test stale handle/remint, new CLI→old host, old CLI→new host,
   pretty/JSON output, and exit status.
6. `--wait-submit` observes the original prompt request. Timeout yields ambiguous
   observation, not permission to resend.
7. Preserve current whole-batch replay/ack unless a new partial-ack contract is
   explicitly negotiated; if added, test new-partial→old-replay/ack and
   old-batch→new-view skew.

### Lifecycle, leases, and liveness

1. Every lifecycle entry point uses the transition primitive; a source ratchet
   rejects direct Task/dispatch/worker lifecycle updates outside it.
2. Inject rollback after legacy projection update and after receipt append; both
   remain atomic. Replay, duplicate, late, and reordered events converge.
3. Active-sibling reports, report after reconnect, missing report, manual update,
   stop, abandon, release, missing-terminal recovery, and federated import cannot
   settle the wrong attempt.
4. Block `closeTerminal` after archive commit: worker-read never says `exited`.
   Return `ptyKilled:false`: archived content remains readable while liveness is
   `unverifiable`. Only confirmed close projects `exited`.
5. Stop either preserves an archive or returns an explicit output-loss receipt.
   Abandon performs no close/archive and retains readable output. Federated
   release archives on the owning server, is idempotent over relay loss, and
   safely refuses on an old peer.
6. Source/execution/home timestamps survive ±24-hour skew, replay, duplicates,
   reconnect, and zombie heartbeat. Freshness uses authority-host receive time;
   contact loss never becomes `exited`.
7. Bulk cleanup paginates and reuses single-resource fencing. It skips
   user-owned, external, transferred, conflicting, federated-home, and
   unverifiable resources and reports a per-resource safe next action.

### Transcript and host routing

1. Direct SSH status reports `/home/ada/session.jsonl` while an identically named
   client-local file contains a sentinel. Worker-read must never return the
   sentinel. A negotiated remote read returns remote content; an old/unsupported
   host returns `remote_capability_unavailable` and safe terminal fallback.
2. Independently test local/folder local FS, Windows-host WSL UNC, direct SSH
   remote RPC, and federated peer execution. No route may fall through to another
   topology.
3. Restart without republished provider status yields `session_not_reported`, not
   an invented exact transcript. Stale same-pane data without launch/process
   proof is rejected or explicitly inexact.
4. More than 50 messages, more than six blocks, oversized text/tool input, and a
   bounded archive set incomplete/limited metadata while source identity stays
   stable.
5. Release after no session, unsupported provider, missing/unreadable path, and
   parse failure; restart and archive-read preserve the original fallback reason
   and warnings.
6. If an in-flight mirror is retained, process replacement and attempt
   supersession cannot append to the old mirror. Test per-attempt/global quotas,
   backpressure, reset/release/retention cleanup, redaction, and absence of
   dispatch capabilities or local path secrets.
7. One exhaustive provider profile drives resolver, decoder, lifecycle, and watch
   capabilities. Alias behavior is explicit, unsupported lifecycle decoders are
   honest, and adding an AgentType fails exhaustiveness until profiled.

### Federation, fleet, and UI

1. Run the old/new Run-home × old/new worker-host matrix in both directions with
   response loss, relay reconnect, unknown optional fields, and unchanged legacy
   fallback. A rejected optional capability must not change old behavior.
2. Old-peer structured-read is probed once per peer fingerprint/runtime epoch;
   concurrent reads coalesce, a new epoch re-probes, and non-`method_not_found`
   errors do not poison the cache.
3. A 100-worker fleet across two peer hosts makes at most one batched observation
   call per host. An unreachable host returns bounded partial rows marked
   `unverifiable` without delaying healthy hosts by N×timeout.
4. Pagination is stable under concurrent updates: no duplicate/omitted rows for a
   snapshot cursor, bounded memory, no transcript bodies, and explicit redaction.
5. Name and spy each replaced DB/RPC caller. Existing push agent status remains
   live while the durable fleet snapshot is stale; the fleet projection does not
   become a second renderer state store.
6. Deterministic fixture/fake-peer tests are mandatory PR gates. Real Windows+WSL,
   SSH relay, and provider-version jobs are separate certification jobs with
   explicit skip/failure policy and bounded diagnostic artifacts.
7. UI comes last: five-worker completion coalesces only root-success alerts;
   input, approval, failure, interruption, stale, and unverifiable remain distinct;
   unread state is per agent and focus is never stolen.

## Claims that should be rewritten in the source plan

| Plan section                                                                          | Required rewrite                                                                                                                                               |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical path / DAG (`orchestration-vnext-implementation-audit.md:20-39`, `:113-123`) | P4 schema and P5 mirror cannot start before P1; P7 fixtures begin with the first wire change; early local fleet projection supports parity.                    |
| “Sending during an active turn” (`:43-73`)                                            | Replace the unproven read/register assertion with the proven commit/notify gap; distinguish mail, nudge, and prompt receipts; state restored-live requirement. |
| “Reading a worker” (`:75-87`)                                                         | Remove attach-time/exact/remote-host claims; document bounded current-status selection and the direct-SSH boundary bug; distinguish WSL UNC from SSH.          |
| P1 (`:98`)                                                                            | Reuse Dispatch as Attempt and existing resource IDs; add retry/creator/role/endpoint facts only.                                                               |
| P2 (`:99`)                                                                            | Reuse mutation receipts and whole-batch ack; scope prompt IDs separately; make draft capability a prerequisite; remove already-fixed cross-Run routing gap.    |
| P3 (`:100`)                                                                           | Avoid enum widening initially; centralize all writers first; define clock domains.                                                                             |
| P4 (`:101`)                                                                           | Describe stop, abandon, local release, and federated behavior separately; extend the existing resource table.                                                  |
| P5 (`:102`)                                                                           | Reuse current provider maps/watchers; add topology-safe routing and completeness metadata; gate any mirror on P1/P4.                                           |
| P6/P7 (`:103-104`)                                                                    | Specify negotiated batch snapshot, partial-host/time-budget semantics, and old/new fixtures before claiming one query or CI coverage.                          |
| Consolidation gates (`:153-172`)                                                      | Replace the impossible every-active-Attempt lease invariant; require a fresh live observation after restart; add false-exited and SSH isolation gates.         |
| PR decomposition (`:174-182`)                                                         | Independently merge additive slices; use only a small final promotion PR and retain shims through a measured mixed-version window.                             |

## Bottom line

The implementation should begin by repairing and characterizing the facts Orca
already has, not by adding parallel IDs, leases, reply keys, provider registries,
or an all-purpose receipt chain. Once identity, transactional writers, topology,
and skew behavior are explicit, the richer lifecycle and fleet projections can
be additive and honest. Without those corrections, the proposed parallelism and
single consolidation PR would make the highest-risk migration and remote-wire
changes land at exactly the point where rollback is hardest.
