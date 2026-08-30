# Orca orchestration vNext: agent ergonomics review

## Verdict

The audit has the right durability and authority boundaries, but its internal
model is too visible in the proposed operator surface. A coordinator should not
have to reason about Run, Task, Attempt, Dispatch, Endpoint, Resource, lease,
receipt, evidence, delivery batch, and process incarnation during the happy
path. Those are valuable durable facts; they should appear in JSON, audit views,
and recovery diagnostics rather than becoming ten concepts every agent must
manipulate correctly.

The everyday model should be only:

- **Work**: what should be done, including dependencies.
- **Worker**: the agent currently trying that work.
- **Message**: durable communication with that worker or coordinator.
- **Attention**: a question, failure, uncertain outcome, or finished root that
  requires action.

Internally, Work may map to Task, Worker to Attempt + Dispatch + Endpoint +
Resource, and Attention to projections over messages, receipts, evidence, and
leases. Stable internal IDs remain essential, but the CLI should carry them
forward in opaque receipts and exact next commands instead of requiring agents
to copy them between ordinary commands.

## Simplify the state model

### Show one primary status and keep evidence separate

The receipt sequence in the audit is useful for proofs, but nine receipt stages
should not become nine peer statuses in lists and notifications. Use one primary
status for scanning, with a short evidence line when expanded.

| Primary user status                             | Meaning                                                                           | Evidence/detail shown on demand                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Starting`                                      | Orca owns a start request, but agent work has not been observed.                  | Furthest delivery receipt such as `terminal_queued` or `provider_submitted`. |
| `Working`                                       | A provider turn or other execution activity is observed.                          | `turn_started`, heartbeat age, process observation.                          |
| `Waiting for input`                             | A durable question or approval blocks progress.                                   | Question, age, and exact reply command.                                      |
| `Finished`                                      | A valid result report was persisted and settled.                                  | Report, artifact evidence, completion time.                                  |
| `Needs review`                                  | Execution appears finished but the result is missing, rejected, or contradictory. | `finished_unverified`/`outcome_unknown`, rejection reason, safe actions.     |
| `Failed`                                        | A terminal failure is proven.                                                     | Exit/report evidence and retry action.                                       |
| `Connection lost — process status unverifiable` | The execution host cannot currently prove liveness or exit.                       | Last contact and reconnect/recovery action.                                  |

`live`, `unverifiable`, and `exited` should remain the exact machine verdicts.
The longer connection-loss wording above is a presentation of
`processVerdict: "unverifiable"`, not a replacement verdict or an inference of
death.

Do not use `ready` as a user-facing lifecycle status. It currently means input
was accepted, which reads as though the worker is ready for more work. Prefer
`Starting — prompt submitted` or `Starting — queued for next turn`.

### Collapse delivery stages in normal output

Normal human output needs four statements:

1. **Saved by Orca** — retrying the same request will not duplicate it.
2. **Queued for the agent** — delivery is pending, possibly until its current
   turn ends.
3. **Submitted to the agent** — provider submission is proven.
4. **Agent started** — a new turn is observed.

Keep the canonical detailed stages (`recorded`, `routed`,
`endpoint_delivered`, `terminal_queued`, `provider_submitted`, `turn_started`,
`report_persisted`, `settled`) in `--json` and `--verbose`. This preserves an
honest evidence ladder without asking an agent to distinguish routing from
endpoint delivery during a routine send.

Every mutating command should return the same receipt envelope:

```json
{
  "result": "queued",
  "summary": "Queued for the agent's next turn. No resend is needed.",
  "requestId": "req_...",
  "furthestStage": "terminal_queued",
  "mayHaveApplied": true,
  "retrySafe": true,
  "nextAction": {
    "label": "Wait for submission",
    "argv": ["orchestration", "receipt-wait", "--request", "req_..."]
  }
}
```

The runtime should generate the idempotency key. Agents should not need to
invent one before the first call. On disconnect, the CLI should print an exact
resume/status command using the generated request ID.

## Role-by-role experience

### Coordinator

The coordinator's normal loop should be:

1. Start work atomically.
2. Inspect one attention-first fleet view.
3. Wait for questions, failures, or completion.
4. Reply or recover using the exact suggested action.
5. Let Orca clean up fresh owned workers after completion is acknowledged.

`task-create` followed by `worker-start` remains useful for constructing a DAG,
but it is a poor default for one-off work because it exposes ID plumbing and can
leave an orphan Task. Add the audit's proposed atomic form:

```bash
orca orchestration worker-start \
  --spec "Review authentication error handling" \
  --worktree current --agent codex --json
```

The response should name the work in plain language, print a short worker alias,
and carry Task/Attempt/Dispatch/Resource IDs in JSON. Later commands may accept
the alias or Dispatch ID; emitted `nextAction.argv` should always use the stable
ID.

The default fleet query should be current-Run and attention-first. `--all`
should be explicit. A coordinator rarely needs every settled historical lane in
the primary view.

### Worker

The injected preamble should answer five questions near the top:

- What am I responsible for?
- Who receives my question and completion?
- May I delegate, and how many generations remain?
- Which one command reports success or failure?
- What must I do after reporting?

The current lifecycle commands are long because they correctly fence authority.
Keep the full command pre-rendered and copyable, but also allow the worker's
authenticated terminal to use concise context-bound verbs:

```bash
orca orchestration ask --question "Should legacy config remain supported?"
orca orchestration done --outcome succeeded \
  --summary "Updated parsing and added compatibility tests" \
  --files "src/config.ts,src/config.test.ts"
```

The runtime, not model-copied text, must bind these to the active Attempt. If the
terminal has zero or multiple active roles, the concise command must fail closed
and print the exact fully qualified command. The existing explicit
`send --type worker_done --task-id ... --dispatch-id ...` remains the portable
compatibility form.

After `done`, wording should be unambiguous:

> Completion recorded. Stop work on this assignment and return to an idle
> prompt. A new assignment will include a new dispatch preamble.

### Nested agent

Nested coordination is currently a setting and an identity rule, but the lived
experience is underspecified. Make nesting a Run policy inherited by every
Attempt, with the global setting acting as a ceiling/default. The preamble should
say either:

> Delegation: allowed for 1 more generation. Child work stays in this Run and is
> shown under your assignment.

or:

> Delegation: unavailable (depth 1 of 1). Complete this assignment yourself or
> ask your coordinator to change the Run policy.

A nested worker should inherit the Run and parent automatically. It must not
create a second Run to delegate, copy its parent's completion capability, or
choose between a coordinator mailbox and worker mailbox. One merged inbox should
label each item with its context and route replies to the originating thread.

If a parent tries to complete while children are active, reject the completion
with the child list and exact choices: wait, stop a child, or explicitly detach
it to the parent coordinator. Never silently settle the parent and orphan its
children.

## Surface-specific review

### Mailbox, wakeups, and acknowledgment

The durable mailbox fixes are necessary, but batch/cursor/reply-channel
mechanics are too easy to misuse. Preserve delivery batches internally while
making these rules visible:

- `check --wait` returns one replayable delivery and a single opaque
  `deliveryId`.
- Every returned message has its own `messageId`, thread, work context, and
  `replayed` flag.
- Acknowledgment is idempotent and may name the whole delivery or individual
  messages.
- A type filter decides when the wait wakes; it must not silently hide older
  actionable mail in the returned delivery.
- A timeout means “nothing new in this window,” not “worker failed.”
- Reply and question retries use the original request/message identity and do
  not create duplicate `Re:` rows.

The CLI should end every delivery with the exact continuation command:

```text
3 messages delivered (delivery dlv_123; replayed: no).
Process all messages, then continue with:
  orca orchestration check --ack dlv_123 --wait --attention
```

Add `--attention` as the normal semantic filter for `question`, `escalation`,
`worker_done`, uncertain outcomes, and proven failures. Keep `--types` for
advanced callers. An agent should not have to memorize the complete message
type vocabulary for the coordinator loop.

Protecting a human draft is a product invariant, not an error footnote. A wake
pointer may set an unread indicator, but it must not type into, submit, replace,
or focus a terminal containing a human draft.

Recommended wording:

- Mid-turn prompt: `Queued for the agent's next turn. No resend is needed.`
- Durable mail without endpoint proof: `Message saved. The agent has not been
notified yet; Orca will retry the wakeup.`
- Replayed delivery: `Replayed after reconnect; you may have seen this before.`
- Cross-Run authorization: `Run exists, but this terminal is not authorized to
message it.`
- Ask timeout: `Question is still pending. Resume waiting; do not ask again.`

### DAG construction

The dependency JSON and separate ID extraction make even a three-node graph
shell-heavy. Retain the low-level API, but add names and `--after` for the CLI:

```bash
orca orchestration task-create --name api \
  --spec "Implement the API change"
orca orchestration task-create --name ui \
  --spec "Update the UI against the agreed contract"
orca orchestration task-create --name integrate \
  --spec "Run integration checks and resolve contract drift" \
  --after api,ui

orca orchestration worker-start --task api --worktree current --agent codex
orca orchestration worker-start --task ui --worktree current --agent claude
orca orchestration status --tree
```

Names are Run-scoped aliases; durable IDs remain authoritative and appear in
JSON. Reject duplicate or ambiguous names before mutation.

The graph should explain blocked work rather than only printing `pending`:

```text
integrate  Blocked by: api (Working), ui (Waiting for input)
Next: answer ui's question; integrate will become Ready automatically.
```

Missing recipes in the audit are: parallel fan-out then join, retrying only one
failed branch, superseding a branch without reopening completed siblings,
handling a parent with live nested children, and resuming a graph after a
runtime restart. These should be first-class documentation examples.

### Terminal and worker read

`terminal.read` and `worker-read` serve different jobs and should not look
interchangeable:

- `worker-read` answers “what has this agent said or done?” It is
  transcript-first, Attempt-scoped, archived, and the orchestration default.
- `terminal.read` answers “what is visible/recent in this PTY?” It is a bounded
  terminal snapshot and never completion proof.

Use these labels in normal output:

```text
Source: Exact provider transcript (Claude)
Scope: this worker attempt
```

or:

```text
Source: Terminal snapshot (advisory)
Reason: this provider does not expose a verifiable transcript
Scope: 50 recent screen lines; not completion evidence
```

Cursors should be opaque continuation tokens. Users should not need to
understand source identity, process incarnation, or byte position. If the
source changes, return:

```text
The read source changed after reconnect. This cursor cannot be continued.
Start a fresh read with:
  orca orchestration worker-read --dispatch dsp_123
```

`worker-show` should expose `readCapability` as one of `exact_transcript`,
`structured_output`, `terminal_snapshot`, or `unavailable`, plus archive
availability. This lets coordinators decide whether reading is useful before
issuing one query per lane.

### Recovery and cleanup

The audit names stop, cancel, supersede, suspend, takeover, retry, abandon,
retain, release, TTL, and clear-Done. That is too many peer actions without a
decision recipe. Present three normal actions and move the rest under advanced
recovery:

- **Stop**: stop this work and clean up only its proven Orca-owned resource.
- **Retry**: create a new Attempt; require explicit placement and refuse to
  duplicate a worker whose old liveness is not settled.
- **Clear finished**: archive and release eligible Orca-owned fresh terminals.

`abandon` remains an expert escape hatch meaning “stop tracking without stopping
resources.” `takeover` remains an authority operation. `supersede` is a durable
relationship created by retry/replacement, not something most users should have
to invoke directly. `retain` is presented as `--keep-terminal` with an optional
duration and reason.

Add a read-only diagnosis command:

```bash
orca orchestration worker-recover --dispatch dsp_123 --json
```

It should return the proven state, partial effects, ownership, whether mutation
may already have occurred, and ordered exact actions. It must not execute a
recovery merely because one looks likely.

Example uncertain-host flow:

```text
Status: Connection lost — process status unverifiable
Last proven: Working, 4m ago on build-linux
No retry was started because the old process may still be live.

Safe actions:
1. Reconnect and inspect:
   orca orchestration worker-recover --dispatch dsp_123 --wait-reconnect
2. Stop the exact owned worker, then inspect the stop receipt:
   orca orchestration worker-stop --dispatch dsp_123
3. Stop tracking without touching remote resources:
   orca orchestration worker-abandon --dispatch dsp_123
```

For fresh worker terminals created and exclusively owned by Orca, default to
release after the coordinator acknowledges accepted completion. Preserve the
archive first. Never auto-release reused, external, user-taken-over,
identity-conflicted, or remote-unverifiable resources. `--keep-terminal` opts a
fresh worker out and records `Kept for debugging until ...`; omission should
not create a permanent lease.

This default removes a mandatory cleanup step from every successful lane while
retaining conservative safety boundaries. `clear --finished` remains an
idempotent bulk repair for eligible residuals and reports each retained row with
its reason and next safe action.

### Fleet query and attention

The fleet query risks becoming a wide dump of every durable fact. Default human
output should answer only: what is it, where is it, what is happening, how fresh
is that knowledge, and what should I do?

```text
WORK         AGENT         WHERE                 STATUS             UPDATED  NEXT
api-review   Codex         local / current       Working            18s      wait
ui-fix       Claude        win-dev / ui          Waiting for input  2m       reply
tests        Codex child   ssh-ci / folder       Unverifiable       4m       reconnect
integrate    —             —                     Blocked            —        waits: api,ui
```

Recommended commands:

```bash
orca orchestration status                 # current Run, attention first
orca orchestration status --tree          # parent/child and dependencies
orca orchestration status --all --history # cross-Run historical view
orca orchestration status --json          # full IDs, receipts, evidence, leases
```

The default sort should be: needs input/approval, failure, unverifiable or
unverified finish, active, dependency-blocked, recently finished. Do not use
provider, host, or creation time as the primary sort.

The single root-completion alert default is good, but define aggregation:

- Questions and approvals alert immediately and separately.
- Proven failures and interruptions alert immediately.
- Child success updates the tree without a desktop alert unless it unblocks a
  root or the user opted in.
- Root success emits one alert after its completion is persisted.
- Reconnect/replay does not re-alert an already acknowledged event.
- No alert steals focus or modifies a draft.

## End-to-end CLI recipes

### One supervised worker

```bash
orca orchestration run-create --objective "Harden authentication" --json
orca orchestration worker-start \
  --spec "Review error handling and add focused tests" \
  --worktree current --agent codex --json

orca orchestration check --wait --attention --timeout-ms 900000 --json
# Process every message. If completion was accepted, the fresh owned terminal
# is archived and released when this delivery is acknowledged.
orca orchestration check --ack dlv_123 --wait --attention \
  --timeout-ms 900000 --json
```

### Send while an agent is busy

```bash
orca orchestration send --to dispatch:dsp_123 \
  --subject "Use the compatibility parser" \
  --body "Keep the Git 2.25 fallback." --wait-submit --json
```

Expected immediate result if the provider is mid-turn:

```text
Queued for the agent's next turn. No resend is needed.
Request: req_456
Wait again with:
  orca orchestration receipt-wait --request req_456
```

Repeating the printed request operation must observe the original send, not add
duplicate text.

### Worker asks and resumes after timeout

```bash
orca orchestration ask \
  --question "Should I preserve the deprecated flag?" \
  --options "preserve,remove" --timeout-ms 600000 --json
```

If the wait ends before a reply:

```text
Question is still pending. Resume waiting; do not ask again.
  orca orchestration ask --resume msg_789 --timeout-ms 600000
```

### Retry a proven failed attempt

```bash
orca orchestration worker-recover --dispatch dsp_old --json
orca orchestration worker-retry --dispatch dsp_old \
  --worktree current --agent codex --json
```

`worker-retry` is the composed ergonomic form of a new start with
`--retry-of`. It must require placement, atomically link the Attempts, keep old
evidence, and reject an unverifiable old worker with the safe stop/reconnect/
abandon choices.

### Read after cleanup

```bash
orca orchestration worker-read --dispatch dsp_123 --limit 100
```

The same command should work after release, state that the source is an archive,
and retain the same Attempt boundary.

## Acceptance tests

### Coordinator happy path

- Starting one worker with `worker-start --spec` atomically creates Work and an
  Attempt. A launch failure leaves either no Work or one receipt with an exact,
  idempotent resume action; it never leaves an unexplained orphan Task.
- The start response can be used without copying a Task ID into a second
  mutation, while JSON still exposes every stable internal ID.
- `status` defaults to the current Run and attention-first ordering; `--all` is
  required to include unrelated Runs.
- A valid completion enters `Finished`, archives readable output, and releases
  only the newly created, proven-owned worker after delivery acknowledgment.
- A reused or user-owned terminal is never auto-released and explains why.

### Mail and receipts

- A mid-turn prompt returns the exact wording `Queued for the agent's next
turn. No resend is needed.` and a generated request ID.
- Retrying or waiting by request ID produces one provider submission and one
  message row across disconnect, CLI restart, and runtime restart.
- Insertion between durable read and waiter registration wakes the waiter.
- A replayed delivery is labeled, preserves message IDs, and does not repeat an
  acknowledged root alert.
- Per-message and whole-delivery acknowledgments are idempotent; acknowledging
  one message does not hide unacknowledged siblings.
- Reply retry/resume creates no duplicate `Re:` row.
- Cross-Run unauthorized and unknown-Run errors are distinct without leaking
  content.
- Wakeups never submit, overwrite, focus, or erase an unsent human draft.

### Worker and nested-agent experience

- Every injected preamble states assignment, completion recipient, remaining
  delegation depth, the exact done command, and post-completion behavior.
- Context-bound `done` succeeds only when the caller has exactly one attested
  active Attempt; zero/multiple contexts fail closed with the fully qualified
  command or an explicit disambiguation action.
- A child cannot use or inherit its parent's completion capability.
- Allowed nested start automatically inherits Run and parent; no `run-create`
  workaround or copied parent ID is required.
- A depth rejection says `Delegation unavailable (depth N of N)` and gives the
  two safe choices: complete locally or ask the coordinator.
- A parent cannot settle with live children unless they are stopped, settled,
  or explicitly detached; the error lists them and exact commands.
- Worker-role and nested-coordinator mail appear in one ordered inbox with
  context labels and replies route to the originating thread.

### DAG usability

- Run-scoped names and `--after name1,name2` create the same durable dependency
  graph as ID-based JSON; duplicate/ambiguous names fail before mutation.
- A join node explains each blocking predecessor and becomes Ready
  automatically when all dependencies settle successfully.
- Retrying one failed branch does not reopen completed siblings or duplicate
  the join.
- After runtime restart, the same tree, attention ordering, and ready set are
  reconstructed from durable facts.

### Read contract

- Claude, Codex, and an unsupported provider show one of the documented
  `readCapability` values before a read.
- `worker-read` labels exact transcript, structured output, terminal snapshot,
  and archive sources; terminal fallback always says it is advisory and not
  completion evidence.
- `terminal.read` never changes lifecycle status based on quiet, prompt-like,
  or ghost screen text.
- Cursor continuation is Attempt- and source-fenced. Source rotation returns an
  exact fresh-read command rather than a generic cursor error.
- The same bounded read works for a released worker and for local, folder, SSH,
  WSL, and federated execution without desktop-side remote file access.

### Recovery and fleet safety

- `worker-recover` is read-only and returns proof, partial effects,
  `mayHaveApplied`, resource ownership, and ordered exact actions.
- Relay or SSH loss yields `processVerdict: unverifiable`, never `exited`, and
  no automatic retry or release.
- Retry requires explicit placement and cannot create concurrent ownership
  unless the operator explicitly chooses a separate parallel lane.
- Stop, retry, release, retain, abandon, and bulk clear are idempotent across
  response loss and runtime restart.
- `clear --finished` releases only eligible proven-owned resources and lists a
  retention reason plus safe next action for every residual.
- A five-worker wave emits at most one default root-success alert while
  questions, approvals, failures, and interruptions remain separate.
- Old peers omit unsupported detail safely: the primary status remains honest,
  unavailable evidence is labeled, and no unnegotiated opcode is required.

## Documentation recipes required before rollout

The implementation audit has strong component acceptance gates but needs a
task-oriented guide. Ship these recipes with vNext:

1. Supervised delegation versus full ownership handoff.
2. Atomic one-worker start, wait, reply, completion, and cleanup.
3. Parallel fan-out and dependency join using names and `--after`.
4. Safe mid-turn send, receipt wait, disconnect resume, and no-resend rule.
5. Worker question timeout and exact `ask --resume` flow.
6. Nested delegation allowed, depth rejected, and parent completion with live
   children.
7. Missing/rejected `worker_done` producing `Needs review` rather than
   indefinite `ready`.
8. Remote `unverifiable` recovery without false exit, retry, or cleanup.
9. Read exact transcript, advisory terminal fallback, and archived output after
   release.
10. Runtime restart with mailbox replay and DAG/fleet reconstruction.
11. Reused terminal, user takeover, keep-for-debugging, TTL expiry, and bulk
    clear safety.
12. Mixed-version local/folder/SSH/WSL/federated behavior and capability
    downgrade.

## Priority changes to the implementation plan

1. In **P0**, define the small primary-status projection and the uniform
   receipt envelope alongside the detailed contract vocabulary.
2. In **P2**, add generated request IDs, exact resume actions, `--attention`,
   and user-facing no-resend wording; do not expose mailbox epochs or wake
   cursors in ordinary output.
3. In **P1/P3**, support context-bound worker `ask`/`done` commands without
   weakening Attempt authority, and specify parent completion with live
   children.
4. In **P3**, add atomic `worker-start --spec`; retain separate Task creation
   for planned DAGs.
5. In **P4**, make recovery diagnosis read-only, make retry composed and
   explicit about placement, and default eligible fresh owned workers to
   archive-then-release after completion acknowledgment.
6. In **P5**, make opaque continuation tokens and `readCapability` part of the
   public contract; label PTY output as advisory in every surface.
7. In **P6**, make current-Run, attention-first status the default and move the
   full identity/receipt/evidence/lease record to JSON and detail views.
8. In **P7**, test the complete user recipes, not only individual transition
   contracts, across provider, OS, folder workspace, SSH, WSL, federation, and
   mixed-version cases.

These changes preserve the audit's durable facts while making the normal
experience teachable: start work, watch attention, answer or recover, and read
the result. The complexity remains available exactly where it is needed—proof,
debugging, compatibility, and safe recovery—without becoming the price of every
successful delegation.
