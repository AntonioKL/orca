---
name: orchestration
description: >-
  Coordinate supervised Orca workers with durable Runs, Tasks, Dispatches,
  messages, questions, gates, and completion tracking. Use when the user asks
  to supervise, monitor, wait for results, coordinate a DAG, or manage blocking
  agent-to-agent questions. For full ownership handoffs or ordinary terminal,
  worktree, and built-in-browser control, use `orca-cli`.
---

# Orca orchestration

Orchestration is Orca's structured coordination layer. It records who owns work,
which attempt is authoritative, and when supervised work has settled.

## Outcome

**Result:** every in-scope Task has one explicit outcome and every settled worker
terminal has a next owner or cleanup decision.

**Done:** all expected Dispatches have settled, every delivered message was
processed before acknowledgment, and each settled worker was reused, explicitly
retained, or released.

**Safe failure:** preserve work and authority and report the state as unknown or
`unverifiable`. A timeout, quiet terminal, missing client, or lost remote
connection is never proof of failure or exit.

## Classify the role

| Current context                                                                                                                                | Role                    | Route                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| The user explicitly asks to supervise, monitor, wait for results, track completion, coordinate a DAG, use a decision gate, or manage ask/reply | Coordinator             | Use the supervised loop below                                                  |
| The current prompt contains a live injected preamble with Task and Dispatch IDs                                                                | Dispatched worker       | Follow the preamble and the worker obligations below                           |
| The user asks to hand off ownership or start another agent/worktree without supervision                                                        | Handoff owner           | Use `orca-cli`; create no Run, Task, or Dispatch and do not monitor completion |
| A message carries a legacy authority label                                                                                                     | Compatibility operator  | Load the legacy contract reference before any lifecycle mutation               |
| No live preamble and no explicit supervision                                                                                                   | Ordinary terminal agent | Do not emit lifecycle messages; use `orca-cli` for terminal/worktree work      |

Model or effort selection does not make a handoff supervised. Never substitute a
non-Orca subagent tool when Orca orchestration provenance was requested. Before
claiming a worker was orchestrated, verify its Task and Dispatch exist.

## Authority and safety floor

- A Run is a durable namespace and coordinator inbox; it does not schedule or
  place workers. A Task is work. A Dispatch is one authoritative Task attempt.
- Lifecycle authority comes from the active Dispatch, not a terminal title,
  copied ID, old database row, provider transcript, or visible pane.
- Workers use the exact executable, handle, capability, Task ID, and Dispatch ID
  in the live preamble. Never reconstruct, translate, or broaden those arguments.
- After remote start, address the worker by Dispatch ID. The execution host owns
  process, filesystem, transcript, stop, and cleanup facts. Preserve the verdicts
  `live` / `unverifiable` / `exited`; contact loss is not process death.
- Folder workspaces are valid. Do not require Git or assume every workspace is a
  worktree.
- When a command requires an exact worktree selector, use the full
  `<repo-id>::<path>` value returned by Orca; a bare repo id is not a worktree id.
- For a newly created workspace, pass that returned value as `id:<newFullWorktreeId>`;
  do not shorten it to the repository id.
- Clients and remote servers update independently. Treat unknown optional fields
  as absent. A new stream operation requires advertised capability because old
  decoders may silently drop unknown opcodes. Never fall back to local execution
  when remote authority or capability is unproven.
- Use the executable selected by the discovery stub for the entire run. In the
  examples below, replace `ORCA` with it; do not create a shell variable or run
  `ORCA` literally. If it fails, report that exact error instead of switching.
- Legacy takeover binds the authenticated invoking terminal; `--from` cannot
  nominate another coordinator. It preserves live work and fences the former
  coordinator, so never take over while that coordinator is still active.
- A successful `orchestration send` proves durable enqueue. Its wake or nudge is
  best-effort attention only; it does not prove the recipient read the message,
  started a turn, or accepted steering.

## Worker obligations

The injected preamble is authoritative. A dispatched worker must:

1. Do only the current Task and use the preamble's `ask` command for a blocking
   coordinator question. Never open a local question TUI the coordinator cannot
   answer. Resume the same message ID after an ask timeout.
2. Send heartbeats only at the cadence in the preamble. A heartbeat proves
   liveness, not completion.
3. Send `worker_done` exactly once, from the dispatched terminal, with a
   three-sentence executive summary, both lifecycle IDs, and explicit
   `--outcome succeeded` or `--outcome failed`. Never encode failure only in prose.
4. Append `--files-modified` and `--report-path` only with real values when
   applicable. After `worker_done`, end the dispatched turn and idle; do not poll
   or start new work.

The generic shape below is only a reminder. Copy the live preamble's command,
including its executable, `--from`, and `--dispatch-capability` values:

```text
ORCA orchestration send --from <worker_handle> --dispatch-capability <capability> --type worker_done --subject "<short status>" --body "<three sentences: work, findings, remaining>" --task-id <task_id> --dispatch-id <dispatch_id> --outcome succeeded
```

A direct user instruction after completion starts new user-owned work and takes
precedence over the idle rule. Do not reuse the settled lifecycle IDs. A
coordinator-supervised follow-up arrives with a fresh preamble and Task block.

## Canonical supervised loop

Confirm the runtime, create or bind one Run, create all independent Tasks, and
start the full independent wave before waiting:

```text
ORCA status --json
ORCA orchestration run-create --objective "<objective>" --json
ORCA orchestration task-create --spec "<worker A task>" --json
ORCA orchestration task-create --spec "<worker B task>" --json
ORCA orchestration worker-start --task <task_a> --worktree current --agent codex --json
ORCA orchestration worker-start --task <task_b> --worktree current --agent claude --json
ORCA orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```

Use Task dependencies only for real ordering. Prefer parallel waves over chains
deeper than three or four steps. Nested workers obey the configured depth limit;
creating another Run does not reset the caller's depth.

A consuming `check` returns the bound Run's oldest FIFO Delivery and replays that
batch until acknowledged. Process every message. Reply to questions, validate
that each `worker_done` belongs to the expected active Dispatch, and decide each
settled terminal's next owner before acknowledging:

```text
ORCA orchestration reply --id <message_id> --body "<answer>" --json
ORCA orchestration worker-release --dispatch <dispatch_id> --json
ORCA orchestration check --ack <delivery_id> --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```

Keep waiting until every expected Dispatch settles. A timeout or empty result is
a checkpoint, not a failure. Do not stop, retry, release, or launch a duplicate
editor from timeout, idle state, heartbeat, relay loss, or missing client alone.

`worker-start` is the normal path. It composes placement, terminal readiness,
prompt injection, and supervised resource ownership. Low-level
`dispatch --inject` is reserved for an expressiveness gap and leaves an
operator-created process unsupervised.

## Task-spec contract

Every Task spec must be self-contained and name:

- **Target:** the files, component, or environment in scope.
- **Change:** the concrete result to produce.
- **Constraints:** invariants, compatibility rules, and do-not-touch boundaries.
- **Ownership:** what this worker may edit and any coordination boundary.
- **Observable acceptance:** the test, output, or evidence that proves completion.

## Completion accounting

After an accepted success or failure report, immediately do exactly one:

1. Reuse the same proven agent terminal for an immediate follow-up Dispatch.
2. Record user-requested retention with `worker-retain`.
3. Run `worker-release`.

Release is post-settlement cleanup, not cancellation. Never release because of
idle state, timeout, heartbeat, status, question, escalation, or a rejected or
stale completion. If release is uncertain, follow its exact recovery receipt;
never substitute `terminal close`. Released output remains readable through
`worker-read`.

A valid `worker_done` settles the Task and Dispatch automatically. Do not follow
it with `task-update --status completed`. Do not end the coordinator turn until
all expected Dispatches and settled terminals are accounted for.

## Conditional references

This compact guide is sufficient for the normal local loop. At an action gate
below, run `ORCA skills get orchestration --full` once and read only the named
bundled reference. `--full` returns this exact kernel and every reference from
the same CLI build in one deterministic document. If an older CLI rejects
`--full`, keep this kernel's safety floor and use that command's `--help`; do not
guess newer flags.

| Action gate                                                                         | Bundled reference                         |
| ----------------------------------------------------------------------------------- | ----------------------------------------- |
| Expanded DAG waves, launch model/effort, same-terminal reuse, or review ownership   | `references/coordinator-loop.md`          |
| Worker ask/resume, heartbeat, escalation, or completion command details             | `references/worker-contract.md`           |
| New worktree, exact workspace, SSH, WSL, or connected-server placement              | `references/placement-and-remote.md`      |
| Inbox replay, follow-up messages, group addresses, or decision gates                | `references/messaging-and-gates.md`       |
| Failed/stopped/unknown attempts, retry, stop, abandon, retain, or uncertain release | `references/recovery-and-cleanup.md`      |
| Custom argv or terminal topology that `worker-start` cannot express                 | `references/low-level-topology.md`        |
| Any legacy label, adopted Run, compatibility receipt, or takeover                   | `references/legacy-contract-migration.md` |

Retired scheduler commands are not aliases for Run creation. Recovery commands
must provide their exact next action; follow it with the same selected executable.
