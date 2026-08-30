# Mailbox, wakeup, pointer, and provider-evidence audit

## Scope and executive summary

This audit follows a message from durable insert through `notifyMessageArrived`, waiter wakeup, PTY pointer injection, explicit `orchestration.check`, and (for worker prompts) provider lifecycle verification. It covers local, folder-workspace, WSL/SSH/federated routing, restart behavior, and the recent Windows reports (`agent_prompt_stalled` while Claude/Codex had queued input; Claude reads exposing only a short visible screen). No source or issue-ledger files were changed.

The durable mailbox is substantially stronger than a best-effort notification: rows are immutable, ordered, replayed until acknowledgement, fenced by Run consumer generation, and routed in bounded pages. The weak boundary is between “bytes accepted by a PTY” and “provider accepted/submitted the prompt”: the current API reports a single success/failure and can mark a real queued prompt as a hard worker failure. Similar boundary ambiguity exists for pointer Enter, waiter registration, ordinary replies, restart repair, and terminal scrollback evidence.

## Current sequence

```text
send/reply/ask
  -> SQLite message/question insert (durable id + sequence)
  -> canonical direct/group/foreign routing
  -> notifyMessageArrived(handle,type)
       -> matching in-memory waiter resolves, OR microtask pointer delivery
            -> idle/live/owner checks; outstanding Run delivery suppresses pointer
            -> PTY write settles; rows get delivered_at and watermark
            -> 500 ms recheck; optional '\r' write; pointer flight retires/redrives
  -> explicit check reads durable rows / creates Run Delivery / marks read on ack
  -> worker prompt path separately waits for workingSequence (provider effect)
```

`messageWaitersByHandle` and pointer flight state are process-memory state. SQLite `read`, `delivered_at`, delivery contract, and Run Delivery rows survive restart; waiter promises and in-flight Enter timers do not.

## What users and agents see today

| Operation                                | Observable behavior                                                                                                                                                                                                                                                                                                                                       | Important edge                                                                                                                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orchestration.send`                     | Persists one row per recipient (group sends share a thread id but have independent read state), returns message/sequence; then wakes waiters or causes an idle Run PTY pointer. Bare handles are canonicalized to Run/Dispatch; foreign targets enqueue a relay.                                                                                          | `worker_done` and heartbeat are authority-checked. Invalid lifecycle mail is converted to a high-priority rejection row. A suppressed heartbeat is read and does not wake a waiter.                                                                          |
| `orchestration.check --run`              | Routes direct snapshots, validates current consumer generation, then returns a replayable FIFO Delivery (up to 50). Existing outstanding Delivery is replayed until `--ack`; `--peek` and `--all` are read-only. `--wait` is an exclusive in-memory long poll with optional type filter.                                                                  | Wake filter only decides when to wake; the subsequent Delivery contains the full oldest batch, including other types. No waiter survives process restart.                                                                                                    |
| `orchestration.check` on active Dispatch | Reads Dispatch mailbox and marks returned unread rows read immediately (unless peek/all); `--wait` resolves on a matching notification, then reads/marks all currently unread matching rows. Inactive Dispatch unread rows are migrated to its Run in bounded pages and Run waiters are notified.                                                         | A worker losing ownership is reported as `dispatch_inactive`; direct-mail cancellation can be interpreted as Run fencing.                                                                                                                                    |
| Direct `check`                           | Unread rows are consumed and lifecycle rows reconciled; `--peek`/`--all` inspect without consuming. A non-signal cancellation while waiting is treated as ownership fencing.                                                                                                                                                                              | Legacy-run rows are inspect-only and cannot be acknowledged by this path.                                                                                                                                                                                    |
| `orchestration.reply`                    | Question replies are transactional/idempotent: same body repeats return `duplicate`, a different body conflicts, and the answer row is immediately read. Ordinary replies mark the original read and insert a `Re: ...` row to `from_handle`.                                                                                                             | Ordinary replies have no idempotency key or Delivery object; repeated calls create repeated unread rows.                                                                                                                                                     |
| `orchestration.ask`                      | Only an active supervised Dispatch may ask. A durable question is inserted, then the sender waits on `dispatch:<id>`; answer/close, timeout, or abort returns typed status. Timeout/abort leaves the question pending for explicit `--resume`; resume does not create a duplicate.                                                                        | Capability and current-dispatch checks fence stale workers.                                                                                                                                                                                                  |
| Automatic pointer                        | Only Run mailboxes are injected. Owner must resolve to a live, writable, idle leaf with live evidence. Unfiltered waiters suppress pointers; filtered waiters reserve their types so unrelated types can be pushed. Pointer text is a literal `orca orchestration check [--run <id>]`.                                                                    | PTY transport settlement precedes `delivered_at`; a 500 ms idle/ownership recheck precedes Enter. If Enter is rejected/uncertain after staging, rows can remain delivered and no automatic replay occurs. Cursor-title path redrives rather than submitting. |
| Notification                             | `notifyMessageArrived` canonicalizes direct/foreign destinations, wakes matching waiters, and queues pointer delivery when no applicable waiter owns the type. A two-second unref'd repoint timer repairs Run pointers after restart/rebind.                                                                                                              | There is no native OS/toast attention projection tied to orchestration mail; PTY pointer is the primary automatic user notice.                                                                                                                               |
| Restart/reconnect                        | Durable undelivered unread Run rows are scanned and repointed after handles return; detached direct rows are routed to their current owner. In-flight memory flights/waiters disappear. Dispatch handles are skipped by restored pointer scheduling.                                                                                                      | Repair is timer/idle dependent; a non-idle or unavailable PTY requires explicit check.                                                                                                                                                                       |
| Worker prompt send                       | Prompt text is bracketed-paste/chunk written through a per-PTY-generation serializer. Claude/Codex use render/quiet gates; other agents use 500 ms (1.5 s on Windows) delay before Enter. Verification waits up to 5 s for `workingSequence` to increment and otherwise throws `agent_prompt_stalled`.                                                    | This proves an observed lifecycle transition, not PTY acceptance, provider submission, or whether text is queued in a TUI. Worker-start contract currently turns this error into `ok:true` with failed Dispatch/task and revokes capability.                 |
| Terminal/worker read                     | `terminal.read` without `--screen` returns bounded tail (runtime caps 2,000 lines/256 KiB; default limit 120). `--screen` returns a visible frame; cursor reads completed transcript lines and bypass visible/provider fallback. `worker-read` prefers an exact provider transcript and otherwise returns terminal fallback with source/warning metadata. | Claude’s TUI visible/terminal tail is not guaranteed full scrollback. A terminal cursor pins subsequent reads to terminal source; screen is advisory, not provider truth.                                                                                    |

## Guarantees that already exist

- `insertMessage(s)` commits immutable IDs and monotonic sequences; default delivery contract is `current_delivery` (legacy Run is explicit).
- Run Delivery creation/ack is transactional, one outstanding delivery per Run, FIFO capped at 50, and replay/idempotent under duplicate ack. Consumer generation fences stale readers.
- Direct routing is paged with a through-sequence snapshot, so arrivals after a check starts are not stolen into that check. Active Dispatch ownership is preserved.
- Pointer state tracks PTY flight, mailbox sequence watermark, parked deliveries, reservation merging, and same-leaf/PTY checks; failed asynchronous transport does not mark rows delivered. Restart repoint scans durable `delivered_at IS NULL` rows.
- Question creation/answer and worker lifecycle authority are durable and capability/process-incarnation checked. Federated sends/answers use relay records and protocol gates.
- Existing tests exercise replay, fencing, routing races, pointer transport settlement, filtered waiters, restart repair, duplicate notifications, ask idempotency, Windows delay, prompt serialization, transcript source changes, and screen/cursor schema.

## Missing guarantees and risk

1. **Prompt receipt conflates stages (high, Windows-visible).** A PTY write accepted plus queued TUI input can still yield `agent_prompt_stalled`; worker start then fails the task and revokes capability even though the provider may consume that same text later. Retrying blindly can duplicate work. There is no durable operation/message id that lets a caller query or safely retry.
2. **Potential lost wakeup (high).** `check` performs a durable read/routing pass, then registers an in-memory waiter; an insertion/notification between those points can be missed, especially after paged routing yields. Registration is not an atomic “subscribe + recheck durable epoch.”
3. **Pointer delivery is not provider submission (high).** `delivered_at` means pointer bytes settled, not Enter accepted or check executed. If the delayed Enter write is rejected/uncertain, staged rows remain delivered and are not automatically redriven; users may see no further nudge while mail remains unread.
4. **Coarse Run acknowledgement (medium).** Ack marks an entire Delivery batch read. Newer mail is held behind the outstanding Delivery for automatic pointer suppression; there is no per-message ack cursor or partial-ack recovery.
5. **Ordinary reply duplication (medium).** Unlike question answers, ordinary reply has no idempotency/delivery receipt. Network retries can create multiple `Re:` rows and unread fan-out.
6. **Restart/waiter convergence (medium).** Waiters are memory-only; restored repoint uses a 2 s timer, idle gating, and skips `dispatch:` pointers. A runtime crash during pointer/Enter loses the in-flight intent, requiring a later idle edge or explicit check.
7. **Platform command mismatch (medium).** `formatMessagePointer` emits literal `orca orchestration check`; the CLI resolver knows `orca` versus `orca-ide` and WSL/remote command context, but pointer formatting does not select it. A pasted pointer can fail or invoke the wrong binary.
8. **No orchestration attention policy (medium).** There is no durable native notification/toast/badge projection, nor a policy for muted/background/remote work. PTY injection is unavailable when a pane is not writable or idle.
9. **Provider output evidence is bounded/advisory (high for completion evidence).** Claude screen/tail reads expose only the visible/limited PTY buffer; cursor mode intentionally avoids snapshots. Worker-read fallback is explicitly terminal source, while exact transcript availability varies by provider/session. A raw TUI frame cannot prove completion or full scrollback.
10. **Remote uncertainty vocabulary needs enforcement (cross-cutting).** Loss of SSH/relay contact is not process death; status must remain `live`, `unverifiable`, or `exited`, and prompt/mail receipts must not infer `exited` from a timeout.

## Focused implementation slices

### A. Atomic wake correctness

Change `src/main/runtime/orca-runtime.ts` (`waitForMessage`), `src/main/runtime/rpc/methods/orchestration.ts`, and `mailbox-notification-coordinator.ts` to register a waiter with a durable mailbox epoch (or insert a register-then-recheck transaction). Re-read unread state immediately after registration; resolve synchronously if the epoch advanced. Preserve exclusive/type-filter semantics. Add deterministic insertion-at-registration tests to `orchestration-mailbox-routing-races.test.ts`, `orchestration-mailbox-notification-consistency.test.ts`, and `orchestration-check.test.ts`, including a process/restart case that falls back to explicit check.

### B. Per-message Run ack and replay

Extend `db/schema/create-core-tables-sql.ts` and `db/runs/run-delivery.ts` with an ack cursor/message set while retaining one outstanding delivery for old clients. Define partial-ack and newer-arrival behavior; make duplicate/old cursor a no-op. Test FIFO partial ack, replay after crash, concurrent consumer fencing, and mixed wake types in `orchestration-run-delivery-db.test.ts` and `orchestration-message-delivery-identity.test.ts`.

### C. Staged prompt receipt and idempotent retry

Split `sendTerminalAgentPrompt`/`writeTerminalAgentPrompt` and `agent-prompt-submission-verification.ts` into observable stages (`recorded`, `terminal_queued`, `provider_submitted`, `turn_started`, `outcome_unknown`). Persist an operation/request id (including worker-start mutation receipt), return it on timeout, and make retry-by-id query status rather than resend. Do not convert `agent_prompt_stalled` directly to task failure when queued/provider state is unknown; require explicit reconciliation. Cover Windows delay, swallowed Enter, Claude/Codex queued TUI, generation/permission races, cancellation, and duplicate retry in `agent-prompt-submission-runtime.test.ts`, `agent-prompt-submission-windows-submit-delay.test.ts`, and `orchestration-worker-start-prompt-contract.test.ts`.

### D. Provider-backed output evidence

In `orchestration-worker-output.ts`, `worker-transcript-read.ts`, runtime read methods, and provider adapters, expose capability/source/coverage (`transcript`, bounded terminal tail, visible screen) and a stable cursor. Add explicit “transcript required” and “coverage incomplete” assertions without pretending a screen is full scrollback. Extend `orchestration-worker-output.test.ts`, `worker-transcript-read.test.ts`, and `terminal-read-screen-cursor.test.ts` with Claude short-screen, cursor pinning, source-change, and SSH-unverifiable cases.

### E. Pointer command and attention projections

Have `formatter.ts` ask `cli-command.ts` for the platform/connection-specific command (including WSL/SSH), and add an explicit pointer receipt state separate from `delivered_at`/Enter. Add durable attention events plus renderer/native notification adapters only after policy (background, mute, remote) is agreed. Test command selection and no-focus/remote behavior in formatter, mailbox notification, and runtime integration tests.

## DAG contribution

```text
contract vocabulary + regression fixtures
  ├─ A atomic wake registration/recheck
  ├─ B per-message ack/replay
  ├─ C staged prompt receipt + idempotent retry
  └─ D provider transcript/coverage contract
A + B ──> restart/reconnect convergence and pointer receipts
C + D ──> operator evidence and safe worker-start settlement
foundations ──> E platform pointer command and native attention projections
```

A–D can proceed in parallel after the shared status vocabulary/fixtures; restart convergence depends on A+B; operator evidence depends on C+D; E consumes all foundations. This keeps the DAG depth to three levels and avoids a scheduler rewrite.

## Testing and acceptance matrix

| Slice             | Existing safety net                                                           | New acceptance                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Wake              | `orchestration-mailbox-routing-races`, notification consistency, check tests  | No insertion between initial read and waiter registration is lost; filtered and exclusive waits remain correct.                |
| Ack               | Run-delivery DB and identity tests                                            | Partial ack/replay is monotonic and generation-fenced; old clients still replay whole batch.                                   |
| Prompt            | submission runtime/verification/Windows-delay and worker-start contract tests | Every receipt names the furthest observed stage; queued/unknown never auto-fails or duplicates on retry-by-id.                 |
| Output            | worker-output, transcript-read, terminal screen/cursor tests                  | Source and coverage are explicit; Claude screen cannot be mistaken for full transcript; remote contact loss is `unverifiable`. |
| Pointer/attention | notification consistency, transport settlement, runtime pointer tests         | `delivered_at`, Enter, and provider stages are distinct; restart/redrive and platform command selection are deterministic.     |

## Explicit non-goals

- This document does not implement source changes and does not edit `orchestration-issues.md`.
- No flag-day rewrite of orchestration, scheduler/DAG engine, or provider TUIs; slices must preserve mixed-version wire compatibility.
- No automatic prompt resend solely because of timeout/stall, and no inference of remote process death from lost contact.
- No promise that a raw PTY/TUI screen equals provider truth or complete scrollback; screen remains advisory.
- No OS notification/focus stealing before a durable, user-configurable attention policy; no bespoke semantics outside a provider capability contract.
- No assumption that every workspace is a git worktree or every execution is local; execution-host ownership and `live`/`unverifiable`/`exited` vocabulary remain in force.
