# Orca orchestration vNext: implementation audit

This is the implementation-oriented companion to `orchestration-issues.md`. It
turns the broad issue list into a small set of contracts that can be implemented
and verified independently, then composed into one DAG and consolidation PR.
The audit is based on the current main-process code, its tests, the Windows
queued-input/Claude-scrollback feedback, and the local reference checkouts in
`/Users/jinwoo/refs`.

## Executive decision

The work is not a rewrite and it is not 30 unrelated bug fixes. Most reports are
symptoms of seven boundaries being implicit: identity, delivery, lifecycle truth,
mutation atomicity, recovery, fleet observability, and provider/host execution.
The existing SQLite dispatch model, capability fencing, worker settlement, and
archive flow are good foundations. vNext should add durable facts and projections
at those boundaries while preserving existing CLI/RPC behavior through additive
fields and compatibility adapters.

The critical path is:

```text
P0 vocabulary + contract fixtures
  ├─ P1 stable Attempt/Endpoint/Resource identity
  │    └─ P3 lifecycle receipts and outcome settlement
  │         └─ P6 fleet projection and attention UI
  ├─ P2 durable mailbox/wakeups and delivery receipts
  │    └─ P6 fleet projection and attention UI
  ├─ P4 lease/recovery supervisor
  │    └─ P6 fleet projection and attention UI
  └─ P5 provider transcript/read capability + telemetry
       └─ P7 federation/SSH/WSL conformance

P3 + P4 + P2 + P5 + P7 → provider/OS/remote conformance matrix → small promotion PR
```

After P0, P1, P2, P4, and P5 can proceed in parallel. P3 needs P1 and the
receipt vocabulary; P6 waits for stable facts rather than inventing another
state store.

## What an agent/user sees today

### Sending during an active turn

Messages are durable SQLite rows. Run delivery is FIFO, bounded to 50 messages,
and one batch is outstanding at a time. A live/idle target may receive an
advisory PTY pointer telling it to run `orchestration check`; a busy target is
redriven at an idle edge or after runtime restart. `orchestration check --wait`
can resolve an in-memory runtime waiter immediately when a message arrives.

The wakeup is not itself durable: if the process misses the in-memory notification,
the message remains safe in the mailbox and is redriven after a fresh live-idle
observation or explicit check. A same-runtime `check --wait` read/register race is
not proven on the current synchronous path and must be characterized before adding
an epoch. A sender usually sees only `Sent <message-id>`/relay `Queued`, not
whether the provider accepted or submitted it. `--ack <deliveryId>` acknowledges
the whole delivered batch; reply-channel rows do not have the same clear
acknowledgment cursor. The proven duplicate seam is commit-versus-notify: if
notification throws after a durable mutation, an exact retry must replay the
recorded result rather than insert another row.

For `terminal send --enter`, `agent_prompt_stalled` can currently be returned
when the target TUI is mid-turn even though the text is queued in its input box
and is consumed when the turn ends. Treating that result as failure causes
duplicate resends. The desired observable facts are separate domains:

```text
mail:   recorded → routed → acked
nudge:  pointer_text_written → submit_confirmed | submit_ambiguous | submit_failed
prompt: terminal_bytes_written → submission_observed → turn_started
worker: report_persisted → settled
```

Not every provider can prove every fact. A queued prompt must never be reported
as a hard delivery failure; the receipt must say which fact is proven and give an
idempotent retry/wait operation.

### Reading a worker

`worker-read --source auto` prefers a bounded decoded projection from the currently
selected provider session and falls back to a bounded, redacted PTY tail with an
explicit reason. Attach-time binding is not guaranteed yet. Cursors are scoped to
dispatch, process incarnation, source identity, and position; released workers are
read from an archived snapshot. Remote/federated reads execute on the owning host;
relay loss is `unverifiable`, never `exited`.

`terminal.read` is intentionally provider-neutral PTY output. In the reported
Windows session, Codex exposed a long buffer while Claude Code exposed about the
current 50-line screen, so raw terminal scrollback cannot be the confirmation
contract. Provider transcript and submitted-prompt history must be separate,
capability-described evidence; screen text remains advisory.

## Implementation matrix

Each row is a bounded workstream. “Not in scope” is part of the contract: it
prevents a worker from expanding a focused change into a second orchestration
system. Paths are likely touch points, not a prescription to edit every file.

| ID / user-facing goal                                                                                                                | Current main behavior and concrete gap                                                                                                                                                                                                                           | In-scope change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Explicitly not in scope                                                                                                                                                                                                | Likely modules                                                                                                                                                                         | Independent verification                                                                                                                                                                                                                                                                                                           | Depends on / parallelism                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **P0 Contract vocabulary**\nEveryone sees the same honest states.                                                                    | `ready`, `input_accepted`, `worker_done`, generic status, and PTY writes are interpreted differently by sender, coordinator, and UI.                                                                                                                             | Publish state/authority matrix; define receipt stages above; define `live`/`unverifiable`/`exited`; add fixture generators and duplicate/late/reordered event contract tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | No behavior migration, event-sourcing rewrite, or AI policy.                                                                                                                                                           | `docs/`, orchestration DB test fixtures, shared status types.                                                                                                                          | Contract tests assert legal transitions, idempotency, and old-client omission safety.                                                                                                                                                                                                                                              | None; gates all other slices.                                                          |
| **P1 Stable identity and authority**\nA retry or nested worker cannot complete the wrong lane.                                       | Dispatch capabilities and pane/process checks are strong, but retry lineage, creator/role, and endpoint-incarnation facts are incomplete.                                                                                                                        | Treat immutable `dispatch_contexts.id` as Attempt ID and retain the existing terminal Resource ID. Add only `retry_of`, creator/role, endpoint-incarnation, and typed unsupervised/remote attachment facts; bind lifecycle/mail/cleanup mutations to Attempt + process incarnation + host.                                                                                                                                                                                                                                                                                                                                                                            | No parallel Attempt/Resource tables, no flag-day ID migration, no trusting model-copied identity, no removal of legacy handles.                                                                                        | `db/dispatch-context/*`, `db/worker-dispatch/*`, lifecycle reconciliation, RPC caller identity, migrations.                                                                            | Stale retry, pane remint, process mismatch, nested parent/child, legacy backfill, and payload-identity spoof tests.                                                                                                                                                                                                                | P0; parallel with P2/P4/P5.                                                            |
| **P2 Durable mailbox and wakeups**\nA message is not lost or falsely failed, and agents do not resend duplicates.                    | SQLite mail and replay are durable, but wake notification is in-memory/advisory; sender lacks queued-vs-submitted truth; cross-run authorization must remain explicit; commit-versus-notify can erase a mutation receipt after the message is already committed. | Complete the existing mutation receipt and durable nudge outbox before notification; keep separate mail, pointer, prompt, and lifecycle receipt domains; expose `recorded/routed/queued/submitted/acknowledged` facts where each is provable; retain whole-batch ack unless partial ack is negotiated and justified; replay labels; prompt idempotency only in the terminal-delivery slice; advisory pointer redrive after restart/idle. Return `queued_pending_turn` (or equivalent) for accepted TUI input and optional `--wait-submit`. Protect human drafts only when provider emptiness is proven. Add a durable wait epoch only if an async race is reproduced. | No guarantee that every provider can prove turn start; no automatic resend of ambiguous prompts; pointers are never authoritative; no new stream opcode without negotiation.                                           | `db/messages/*`, `db/runs/run-delivery.ts`, `mailbox-notification-coordinator.ts`, `mailbox-pointer-*`, `orca-runtime.ts`, orchestration RPC/CLI handlers, prompt-submission verifier. | Unit tests for commit/notify crash, receipt transitions, ack/replay races, queued-mid-turn no-duplicate; restart/idle wake integration; Windows Claude/Codex matrix; cross-run auth. Characterize (do not assume) waiter-registration races.                                                                                       | P0; parallel with P1/P4/P5.                                                            |
| **P3 Attempt lifecycle and completion truth**\nThe coordinator can tell “still running”, “finished”, and “unknown” apart.            | `worker_done` is a validated fast path and settlement is transactional, but Task/Dispatch/worker status has multiple writers; `ready` proves input accepted, not provider turn start; late reports and missing reports need one guarded authority.               | First route every lifecycle writer through a guarded transition primitive that updates legacy projections and appends receipts atomically. Then add observation/outcome projections (`outcome_unknown`/`finished_unverified`) and host-computed heartbeat age without widening closed enums in the first slice.                                                                                                                                                                                                                                                                                                                                                       | No success from quiet PTY/Git cleanliness/prose; no collapse of SSH loss into exit; retain worker_done fast path and circuit-breaker policy initially.                                                                 | `db/dispatch-context/*`, task status writers, lifecycle reconciliation/coordinator, heartbeat and RPC receipt code.                                                                    | Direct-update ratchet, rollback injection, event replay/order/idempotency; active-sibling races; report-after-reconnect; missing-report; SSH `live/unverifiable/exited`; old/new client optional fields.                                                                                                                           | P0 + P1 + P2; then enables P6.                                                         |
| **P4 Recovery and resource leases**\nRestart, stop, retry, and explicit release/recovery converge without killing the wrong process. | Stop/abandon/release already fence capabilities, but archive/liveness and local/federated close semantics differ. Existing resource accounting is useful; retention-expiry metadata, TTL policy, and bulk cleanup are validate-first follow-up work.             | Preserve archive-before-close/liveness truth, existing resource accounting, ownership/release fencing, explicit retain/release, recovery receipts for observed operations, and remote release/archive behavior. Validate retention reason/age with a dry-run cleanup protocol before proposing expiry metadata, TTL policy, or paginated/bulk cleanup; add richer operation nouns only after a concrete unrecoverable workflow is measured.                                                                                                                                                                                                                           | No broad pane/title close, no auto-release external/user-owned/transferred resources, no retry that duplicates ownership, and no automatic release or recovery heuristic that overrides takeover or identity conflict. | `db/worker-dispatch/*`, `db/worker-terminal/*`, ownership/release reconciliation, federation control, archive reader.                                                                  | False-exited archive, stop output-loss, abandon retention, release identity conflict, reconnect, and remote release. Deferred retention/TTL/cleanup requires retention reason/age measurement, dry-run coverage of external/user-owned/transferred/federated/unverifiable resources, and explicit policy/fencing acceptance tests. | P0 + P1 + P3; behavior follows evidence; retention/TTL/cleanup remains validate-first. |
| **P5 Provider transcript/read contract**\nCoordinator evidence is consistent across Claude, Codex, folder workspaces, SSH, and WSL.  | Provider transcript decoders/resolvers are specific (Claude/Codex/Grok/OMP); `worker-read` is transcript-first with PTY fallback; `terminal.read` is screen/tail only; direct SSH routing and archive fallback provenance need correction.                       | Consolidate existing provider maps only where behavior changes; carry host/connection identity into resolution; expose read source/exactness/completeness/fallback metadata; preserve source/process cursor fencing. Gate any in-flight mirror or passive stream on a demonstrated loss/latency case and the identity/remote contracts.                                                                                                                                                                                                                                                                                                                               | No universal transcript format, no desktop-side SSH/WSL file reads, no replacing interactive PTY UX with JSONL, no secret/capability logging.                                                                          | `native-chat/*`, `worker-transcript-*`, `orchestration-worker-output.ts`, terminal query RPC/CLI, provider profiles, archive/relay paths.                                              | Decoder fixtures; SSH/WSL topology tests; cursor rotation/process replacement; archive provenance; screen-vs-transcript characterization; subscription gaps/backpressure; redaction/size limits.                                                                                                                                   | P0; topology/identity fixtures first.                                                  |
| **P6 Fleet query and attention projection**\nOne query answers what is running, what needs attention, and the next safe action.      | `workerList` already provides a local projection and renderer status is push-fed; facts are split across lanes, and remote observation is per-dispatch.                                                                                                          | Extend/combine the existing local read-only projection first. Add a negotiated per-host batched snapshot only after P7 fixtures, with budgets, partial-host errors, stable pagination, and no transcript bodies. Project root completion, input, approval, failure, and interruption separately; validate notification defaults.                                                                                                                                                                                                                                                                                                                                      | No second UI state store, no merge queue/cost budget in kernel slice, no blanket notification suppression, no assumption that the renderer polls every lane.                                                           | coordinator projection, RPC/CLI list/show, renderer fleet view/notifications (after contracts), federation query.                                                                      | Local parity; bounded 100-worker/two-host calls; stale/unknown display; pagination; partial-host budgets; notification coalescing; redaction.                                                                                                                                                                                      | P2 + P3 + P4 + P5/P7; do last.                                                         |
| **P7 Cross-host/provider conformance**\nThe same contract survives mixed versions and remote loss.                                   | Execution-host ownership and capability negotiation exist, but skew tests and batched remote semantics are fragmented.                                                                                                                                           | Make old/new DB, RPC, relay, provider, SSH, WSL, and federated fixtures continuous infrastructure; cache unsupported capabilities by peer fingerprint/runtime epoch; add batched host snapshot negotiation only when P6 needs it.                                                                                                                                                                                                                                                                                                                                                                                                                                     | No new unnegotiated stream opcodes; no treating relay/client absence as process death.                                                                                                                                 | federation RPC, SSH/WSL adapters, protocol/capability cache, remote compatibility tests, provider fixtures.                                                                            | Matrix is executable from R0; assert `unverifiable` on contact loss, typed unavailable errors for individual reads, and safe downgrade on old peer.                                                                                                                                                                                | P0 + P1; continuous alongside P2–P6, not a final-only gate.                            |

## Detailed DAG and worker boundaries

Use one worker per row (or split P4 into recovery and release). A worker
may add tests and contracts for its row, but should not modify another row's
projection or silently change CLI semantics. Each slice must leave a green,
independently runnable test target and a short migration/rollout note.

```text
P0 contract fixtures
├── P1 identity/authority ───────┐
│                                ├── P3 lifecycle/completion ──┐
├── P2 mailbox/receipts ─────────┘                             │
├── P4 leases/recovery ───────────────(schema may start early)─┤
└── P5 transcript/provider ──┐                                ├── P6 fleet/attention
                              └── P7 remote/provider matrix ───┘

P3 + P4 + P2 + P5 + P7 → final conformance and a small promotion PR
```

Recommended implementation order inside a slice:

1. Add characterization tests for current behavior (including the current
   whole-batch ack, pointer command, and provider-specific screen limits).
2. Add durable schema/receipt fields with dual-read/dual-write where needed.
3. Add runtime behavior behind an additive capability or feature gate.
4. Exercise restart, duplicate, timeout, and remote-loss cases.
5. Promote the new projection only after parity checks pass; retain a rollback
   path for old clients and old remote servers.

## Terminal read: explicit product contract

The references do not implement one universal transcript mechanism:

| Product   | Default read source                                                                                  | Provider-specific?                                               | Fallback/remote behavior                                                                    | Orca takeaway                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Overstory | Runtime adapters and structured headless stdout/EventStore; tmux visibility fallback.                | Adapter API is agent-agnostic; parsers are provider-specific.    | Local-focused; no comparable SSH/federation contract.                                       | Keep a narrow provider adapter boundary and prefer structured events.                                          |
| Paperclip | Adapter stdout/stderr/system chunks into durable NDJSON RunLogStore; optional object-storage mirror. | Provider-neutral log chunks behind provider adapters.            | Live tail plus durable archive survives pod loss.                                           | Measure Orca output loss first; consider bounded in-flight mirroring only if a concrete gap remains.           |
| Herdr     | Execution-host terminal history (`visible`, `recent`, `detection`) and passive subscriptions.        | Read API agent-agnostic; lifecycle/session hooks provider-aware. | Server owns panes; remote attach runs reads on the target host; explicit `unknown`.         | Keep screen/recent/detection intent distinct; instrument existing subscriptions before adding a passive watch. |
| Gas Town  | tmux transport by default; Claude JSONL watcher and OTel events are opt-in.                          | Lifecycle protocol generic; transcript watcher Claude-specific.  | Restart-first sessions and append-only feed/audit events; no general SSH transcript reader. | Use tmux only as bounded evidence, not truth; correlate output with run/attempt IDs.                           |

Therefore vNext introduces no fundamentally novel orchestration concept. It
combines proven patterns—durable receipts/mail, server-owned execution,
provider adapters, append-only audit/evidence, leases, and explicit unknown
states—into one Orca contract while retaining Orca-specific desktop/worktree/
SSH/WSL integration. The novel part is the composition and the explicit
cross-provider semantics, not a new agent paradigm.

## Acceptance gates for consolidation

- A prompt accepted while a provider turn is busy returns `terminal_queued` (or
  `queued_pending_turn`), never a hard failure; retrying its id is idempotent.
- A durable message survives runtime restart and is redriven after a fresh
  live-idle observation or explicit check; replay is labeled and ack is
  idempotent. An offline process is not described as having been woken.
- After local authority attachment, every supervised local dispatch has exactly
  one execution-host resource or an explicit external/remote attachment;
  pre-attach, unsupervised, and federated-home rows have typed absence. Every
  residual resource has a retention reason and safe next action.
- No false `ready` or `exited` is emitted solely from a PTY write, timeout, quiet
  screen, missing client inventory, or relay loss.
- `worker-read` and `terminal.read` state source, exactness, cursor scope, and
  fallback reason; Claude/Codex/unsupported-provider behavior is covered by
  fixtures and the screen-vs-transcript distinction remains explicit.
- A bounded local fleet projection has parity with existing `workerList`; a
  negotiated per-host snapshot is promoted only after its latency/partial-host
  tests pass. Input, approval, failure, interruption, stale, and unverifiable
  remain distinct.
- A five-worker wave's notification policy is measured before changing defaults;
  drafts are untouched whenever composer emptiness is unproven.
- Existing issues become regression/contract tests or are recorded as accepted
  limitations. No source change is merged without the relevant focused test
  target and a remote/Windows impact note.

## Suggested PR decomposition

1. **Contracts PR:** P0 plus characterization fixtures and shared types.
2. **Identity + mailbox PRs:** P1 and P2 in parallel, each additive and dual-read.
3. **Lifecycle + leases PRs:** P3 and P4 after contract/identity tests pass.
4. **Transcript + federation PRs:** P5 and P7, including provider/OS matrix.
5. **Fleet/attention PR:** P6 consumes only durable facts from the prior PRs.
6. **Small promotion PR:** after the additive slices pass full conformance,
   change consumers/defaults and remove only shims shown unused by mixed-version
   telemetry. Do not merge all implementation branches as one feature PR.

This keeps each implementation focused, reviewable, and independently verifiable
while still yielding the coherent DAG the orchestration redesign needs.
