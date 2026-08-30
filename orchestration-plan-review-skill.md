# Orca orchestration skill rewrite audit and replacement draft

Date: 2026-08-27
Runtime audited: Orca `1.4.191-adhoc.20260827054943`
Live source: `orca skills get orchestration` (435 lines)

## Executive recommendation

Replace the current flat guide with a phase-loaded kernel: keep role classification, authority, the common supervised loop, the worker completion contract, and the remote uncertainty floor always loaded; move placement variants, mailbox details, lifecycle recovery, low-level topology, and legacy adoption into references loaded at their acting boundary.

The rewrite should preserve the current CLI grammar and safety contracts. Its main behavior change is instructional: `worker-start` becomes the only normal-path recipe, a worker sees its completion contract near the top, and uncommon compatibility detail no longer displaces the coordinator loop.

The current CLI serves one Markdown document and the installed skill is only a discovery stub. Progressive disclosure therefore needs a packaging decision: either teach `skills get` to materialize a version-matched skill package with references, or ship the compact kernel as the served guide and use command `--help` plus a separately addressable versioned reference surface. Do not add relative references that the installed/served skill cannot actually load.

## Evidence and design influence

The audit used:

- The version-matched orchestration guide and current command help for `worker-start`, `check`, `worker-show`, `worker-release`, `run-use`, and `send`.
- The current guide source and its prose-coupled regression tests in `config/scripts/orchestration-skill-guidance.test.mjs`.
- `orchestration-vnext-implementation-audit.md`, `orchestration-issues.md`, and the three focused audit artifacts in this worktree.
- The compound-engineering plugin's root agent instructions, portable skill-authoring standard, `ce-skill-work` review rules, phase-loaded skills (`ce-plan`, `ce-work`, `ce-code-review`), and specialist prompt assets.

The useful compound-engineering patterns are:

1. Lead with an outcome spine: result, next consumer, done condition, and safe failure direction.
2. Keep the protocol kernel inline; load conditional or late mechanics immediately before they act.
3. Give each reference one owning concern. Do not duplicate commands across the caller and callee.
4. Treat a description as an activation pointer, not a feature catalog.
5. Give delegated work a distinct scope, output contract, and synthesis owner.
6. Pin one fragile command recipe, then provide a named failure hatch.

## Audit findings

### Change: the common path is not the document's spine

The guide introduces tool boundaries and then places roughly sixty lines of contract migration before the ownership model and normal coordinator loop. A first-time coordinator reaches `worker-start` only after messaging, Task/Dispatch detail, and nesting rules. A dispatched worker's most important rule—send `worker_done` exactly once, then end the dispatched turn—appears near the end.

Requested condition: the normal role must be classifiable and executable from the always-loaded kernel. A coordinator should reach `run-create -> task-create -> worker-start -> check -> release/reuse` before optional detail; a worker should reach its exact completion contract before coordinator-only mechanics.

### Change: duplicated boundaries invite drift

Full-handoff classification is repeated in the description, When To Use, Ownership, Full Handoffs, Worker Terminals, and Next Action. Placement is split between the preferred loop, Full Handoffs, and Worker Terminals. Lifecycle cleanup appears in the preferred loop, Agent Guidance, and Next Action.

Requested move: state each condition once at its owning layer. The orchestration skill should classify a full handoff and route to `orca-cli`; it should not reproduce `orca-cli`'s worktree, custom-model, and terminal-send recipes.

### Change: the final example teaches the fallback

The guide calls `worker-start` preferred, but its final example manually creates a terminal, waits for TUI idle, and uses low-level `dispatch --inject`. This makes the uncommon unsupervised topology the memorable recipe.

Requested condition: the canonical example must use `worker-start`. Low-level dispatch belongs in a conditional reference whose entry criterion is “the composed start cannot express the required topology or argv.”

### Change: role-specific obligations are mixed

Coordinator, worker, full-handoff owner, legacy worker, and recovery operator instructions share one linear document. This causes rules such as `--from` omission for coordinators to sit beside injected worker commands that intentionally include `--from` and a dispatch capability.

Requested move: route by role near the top and give worker/coordinator protocols separate owned sections. The worker must copy the exact injected command, including executable, terminal handle, capability, Task ID, and Dispatch ID; generic coordinator advice must not override it.

### Change: heartbeat syntax has two sources of truth

The live guide's Agent Guidance shows raw `--payload` JSON for heartbeat, while the current `send --help` and injected preamble support typed `--task-id`, `--dispatch-id`, and `--phase` flags. Typed flags avoid PowerShell JSON quoting failure and match the live worker contract.

Requested move: make the injected preamble authoritative and show typed flags in the generic worker recipe. Keep raw payload as a compatibility implementation detail, not the taught path.

### Change: remote safety is scattered instead of being a floor

The guide correctly says that remote work is addressed by Dispatch ID after start and that remote `current`/`new-child` are invalid, but the SSH verdict vocabulary is only visible inside recovery detail. The project instruction is stricter: the execution host owns execution-sensitive facts, and contact loss is never process death.

Requested condition: every coordinator path must preserve execution-host ownership and the verdicts `live`, `unverifiable`, and `exited`; later operations route by Dispatch ID and never by guessed local terminal state.

### Change: prose regression tests encode layout, not only contracts

The current test suite asserts exact headings, sentences, and command snippets. Those tests protect real incidents, but they also make progressive disclosure look like contract deletion because moving a rule to a reference fails the test.

Requested move: retain incident coverage while relocating assertions to the owning reference and add package-integrity tests. Test observable obligations and required load stubs, not accidental section placement.

### Verify: versioned reference delivery

`orca skills get orchestration` currently prints one document, and the installed skill directory contains only `SKILL.md`. Before introducing reference paths, verify how every supported harness receives and resolves a version-matched skill package. If package delivery is not available, use the single-file fallback described below.

### Verify: `check --format` help shape

The live guide uses `check --peek --format --json` as a boolean formatting flag, while current help renders the option description as `--format <png|jpeg>`. Confirm whether this is only generic option metadata leakage or a real CLI contract mismatch before carrying the recipe into the rewrite.

### Consider: a worker preamble mini-kernel

The injected preamble already gives workers exact lifecycle commands. Keeping the worker section in the general guide is still necessary for inherited-context classification and recovery, but Orca could version and test the preamble as a small standalone contract. This would reduce reliance on a worker searching the coordinator guide after dispatch.

## Proposed package structure

```text
orchestration/
├── SKILL.md
└── references/
    ├── coordinator-loop.md
    ├── worker-contract.md
    ├── placement-and-remote.md
    ├── messaging-and-gates.md
    ├── recovery-and-cleanup.md
    ├── low-level-topology.md
    └── legacy-contract-migration.md
```

`SKILL.md` should target 140-190 lines. It owns activation, role classification, the authority floor, the canonical loop, reference routing, and completion. Each reference owns commands and edge cases for one concern; no reference restates the entire loop.

If the CLI cannot deliver references atomically, flatten only the five safety-critical sections into the served guide and expose the remaining material through current command `--help`. Do not create dead read instructions.

## Replacement `SKILL.md` draft

The following is a content draft, not a source patch.

````markdown
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

## Outcome

**Result:** every in-scope Task has one explicit terminal outcome and every
settled worker terminal has a next owner or cleanup decision.

**Next consumer:** the coordinator synthesizes accepted worker results for the
user or starts the next ready wave.

**Done:** all expected Dispatches have settled; every delivered message was
processed before acknowledgment; and each settled worker was immediately
reused, explicitly retained, or released.

**Safe failure:** preserve work and authority, report `outcome_unknown` or
`unverifiable`, and expose the next safe command. A timeout, quiet terminal,
missing client, or lost remote connection is never proof of failure or exit.

## Classify the request

| Context                                                                                                             | Act as                 | Route                                                                                   |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------- |
| The user explicitly asks to supervise, monitor, wait for results, coordinate a DAG, use a gate, or manage ask/reply | Coordinator            | Use the supervised loop below                                                           |
| The current prompt contains a live injected Dispatch preamble with Task and Dispatch IDs                            | Worker                 | Read `references/worker-contract.md` now and follow the preamble exactly                |
| The user asks to hand off ownership or start another agent/worktree without supervision                             | Handoff owner          | Invoke `orca-cli`; do not create a Run, Task, or Dispatch and do not monitor completion |
| A message has a legacy authority label                                                                              | Compatibility operator | Read `references/legacy-contract-migration.md` before any lifecycle mutation            |
| No live preamble and no explicit supervision                                                                        | Ordinary agent         | Do not emit lifecycle messages; use `orca-cli` for terminal/worktree operations         |

Model or effort selection does not make a handoff supervised. Never substitute
a non-Orca subagent tool when Orca orchestration provenance was requested.

## Authority and identity floor

- A Run is a durable namespace and coordinator inbox; it does not schedule or
  place workers. A Task is work; a Dispatch is one authoritative Task attempt.
- Lifecycle authority comes from the active Dispatch, not a terminal title,
  copied ID, old database row, provider transcript, or visible pane.
- Workers send lifecycle messages from their own dispatched terminal using the
  exact executable, handle, capability, Task ID, and Dispatch ID injected by
  Orca. Do not reconstruct or broaden those arguments.
- After remote start, address the worker by Dispatch ID. The execution host owns
  process, filesystem, transcript, stop, and cleanup facts. Preserve
  `live` / `unverifiable` / `exited`; loss of contact is not process death.
- Folder workspaces are valid placements. Do not require Git or assume every
  workspace is a worktree.
- Treat unknown fields as absent on mixed versions. Do not send a new remote
  stream operation unless the connected server advertised it.

Examples use `orca`; use the executable selected by the discovery stub for the
whole run. If it fails, report that exact error rather than switching binaries.

## Canonical supervised loop

Confirm the runtime, create or bind one Run, create all independent Tasks, then
start the independent wave before waiting:

```bash
orca status --json
orca orchestration run-create --objective "<objective>" --json
orca orchestration task-create --spec "<worker A task>" --json
orca orchestration task-create --spec "<worker B task>" --json
orca orchestration worker-start --task <task_a> --worktree current --agent codex --json
orca orchestration worker-start --task <task_b> --worktree current --agent claude --json
orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```
````

Use Task dependencies for real ordering. Prefer waves over chains deeper than
three or four steps. Nested workers obey the runtime depth limit; creating a new
Run never resets the caller's depth.

Process every message in the returned Delivery. Reply to questions, validate
that each `worker_done` belongs to the expected active Dispatch, and decide the
terminal's next owner before acknowledging:

```bash
# Question in the Delivery:
orca orchestration reply --id <message_id> --body "<answer>" --json

# Settled worker with no immediate follow-up:
orca orchestration worker-release --dispatch <dispatch_id> --json

# Then acknowledge the whole processed Delivery and continue waiting:
orca orchestration check --ack <delivery_id> --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```

A timeout or empty result is a checkpoint. Keep waiting while the Dispatch is
live or unverifiable. Read `references/recovery-and-cleanup.md` only when a
worker fails to start, stops, reports an unknown outcome, needs retry, or cannot
be released normally.

## Placement gate

Use `current` or an exact existing workspace by default. A fresh worker means a
fresh agent terminal, not a new Git worktree. Create a new worktree only when
the user requested one or a concrete checkout/filesystem conflict makes sharing
unsafe. Before any new, remote, SSH, or WSL placement, read
`references/placement-and-remote.md`.

`worker-start` is the normal lifecycle owner. Read
`references/low-level-topology.md` only when it cannot express required custom
argv or topology. Low-level `dispatch --inject` is tracked but unsupervised and
does not grant `worker-stop` ownership of the operator-created process.

## Messaging and gates

Use `dispatch:<dispatch_id>` for attempt-specific coordinator guidance. Use
`ask`/`reply` for a worker's blocking question and coordinator response. Use a
gate only for a coordinator-managed DAG decision. For inbox replay, group
addresses, cursors, and gate recipes, read `references/messaging-and-gates.md`.

## Completion

After an accepted success or failure report, immediately do exactly one:

1. Reuse the same proven agent terminal for an immediate follow-up Dispatch.
2. Record user-requested retention with `worker-retain`.
3. Run `worker-release`.

Release is post-settlement cleanup, not cancellation. Never release because of
idle state, timeout, heartbeat, status, question, escalation, or a rejected or
stale completion. Released output remains available through `worker-read`.

Do not manually mark a Task completed after a valid `worker_done`; settlement
already updates the Task and Dispatch. Do not end the coordinator turn until
all expected Dispatches and settled worker terminals are accounted for.

````

## Reference ownership and required content

### `references/coordinator-loop.md`

This is optional if the canonical loop remains fully inline. If used, the inline kernel must retain the loop order and stop classes; the reference may own expanded DAG recipes, `task-list --ready --brief`, model/effort selection, and same-terminal follow-up.

Required recipes:

```bash
orca orchestration task-create --spec "<dependent work>" --deps '["<task_id>"]' --json
orca orchestration task-list --ready --brief --json

orca orchestration worker-show --dispatch <dispatch_id> --json
orca orchestration worker-start --task <next_task_id> --terminal <agent_terminal_handle> --json
````

Rules:

- `--model` applies to a fresh Claude, Codex, or Cursor launch; `--effort` requires `--model`.
- Neither `--model` nor `--effort` combines with `--terminal`.
- Compare `launch.requested` with `launch.effective`; do not claim a model from requested arguments alone.
- A review-only completion authorizes synthesis, not coordinator edits. Preserve any next owner named by the user.

### `references/worker-contract.md`

This reference begins with: “The injected preamble is authoritative. Copy its command rather than reconstructing flags.”

Required worker recipes, parameterized by the exact injected executable, handle, and capability:

```bash
<ORCA> orchestration send --from <worker_handle> --dispatch-capability <capability> \
  --type heartbeat --subject "alive" \
  --task-id <task_id> --dispatch-id <dispatch_id> --phase "implementing"

<ORCA> orchestration ask --from <worker_handle> --dispatch-capability <capability> \
  --question "<question>" --options "<choice-a>,<choice-b>" --timeout-ms 600000

<ORCA> orchestration ask --from <worker_handle> --dispatch-capability <capability> \
  --resume <message_id> --timeout-ms 600000

<ORCA> orchestration send --from <worker_handle> --dispatch-capability <capability> \
  --type worker_done --subject "<short status>" \
  --body "<three sentences: work, findings, remaining>" \
  --task-id <task_id> --dispatch-id <dispatch_id> \
  --outcome succeeded --files-modified "path/a,path/b" \
  --report-path "<optional durable report>"
```

Rules:

- Send heartbeat only at the cadence requested by the live preamble. It proves liveness, not completion.
- Use `ask`, never a local user-question TUI, when the coordinator must answer. A timeout leaves the question pending; resume the same message ID.
- Use escalation only when the coordinator must intervene before completion.
- Send `worker_done` exactly once with explicit `succeeded` or `failed`; never encode failure only in prose.
- After `worker_done`, end the dispatched turn and idle. A direct user instruction starts new user-owned work and must not reuse settled lifecycle IDs.

### `references/placement-and-remote.md`

This reference owns placement and execution-host boundaries.

Normal recipes:

```bash
# Fresh agent in the current workspace; setup is not rerun.
orca orchestration worker-start --task <task_id> --worktree current --agent codex --json

# New stacked child worktree.
orca orchestration worker-start --task <task_id> --worktree new-child --name <name> --agent codex --setup run --json

# New independent top-level worktree.
orca orchestration worker-start --task <task_id> --worktree new-top-level --name <name> --agent codex --setup run --json

# Connected server; later commands omit --on and route by Dispatch ID.
orca orchestration worker-start --task <task_id> --on <environment> \
  --worktree new-top-level --repo <exact_remote_repo_selector> \
  --name <name> --agent codex --setup run --json
```

Rules:

- Current and exact existing workspaces create a fresh agent terminal unless `--terminal` is explicit.
- New worktrees use agent-first creation and run setup by default. `start-immediately` may show setup `running` while the worker is ready; only repository `wait-for-setup` gates prompt delivery on setup success.
- Child/top-level Orca lineage, Git base, filesystem isolation, coordination parentage, UI grouping, and execution host are separate decisions.
- Remote `current` and `new-child` are invalid. Use an exact remote workspace selector, or `new-top-level` with an exact remote repository selector.
- Pass `--on` only to `worker-start`. Use `worker-show`, `worker-read`, `send --to dispatch:<id>`, `worker-stop`, and cleanup by Dispatch ID afterward.
- The execution host owns process and filesystem facts. Never replace a remote action with a local terminal command or local file inspection.
- For SSH and disconnected relays, preserve `live`, `unverifiable`, and `exited` exactly. No contact is `unverifiable`, not `exited`.
- Folder workspaces must remain valid when the task has no Git worktree.

### `references/messaging-and-gates.md`

Required recipes:

```bash
orca orchestration send --to dispatch:<dispatch_id> --subject "Follow-up" --body "<guidance>" --json
orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
orca orchestration reply --id <message_id> --body "<answer>" --json

orca orchestration gate-create --task <task_id> --question "<decision>" --options '["a","b"]' --json
orca orchestration gate-resolve --id <gate_id> --resolution "<choice>" --json
```

Rules:

- A consuming coordinator check returns the bound Run's oldest FIFO Delivery, up to 50 messages, and replays it until acknowledged.
- Process the complete Delivery before `--ack`; type filters decide when a waiter wakes, not which older actionable mail may be skipped.
- `--peek` and `--all` are read-only inspection, not coordinator progress.
- Group addresses are for intentional fan-out status or questions, never Dispatch lifecycle messages.
- `worker_done` and heartbeat are Dispatch-scoped and never target groups.
- `ask` is a worker question; gates are coordinator-owned DAG decisions.

### `references/recovery-and-cleanup.md`

The recovery decision table should be the reference's opening content:

| Proven state           | Safe action                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `ready` or active      | Keep waiting; optionally read bounded output                       |
| `failed` or `stopped`  | Start a replacement with `--retry-of`; repeat placement explicitly |
| `outcome_unknown`      | Inspect; then choose `worker-stop` or explicit `worker-abandon`    |
| accepted `worker_done` | Reuse, retain, or release                                          |
| remote contact lost    | Preserve `unverifiable`; do not stop/retry from absence alone      |

Required recipes:

```bash
orca orchestration worker-show --dispatch <dispatch_id> --json
orca orchestration worker-read --dispatch <dispatch_id> --limit 50 --json
orca orchestration worker-start --task <task_id> --retry-of <dispatch_id> \
  --worktree <explicit-placement> --agent <agent> --json
orca orchestration worker-stop --dispatch <dispatch_id> --json
orca orchestration worker-abandon --dispatch <dispatch_id> --json
orca orchestration worker-retain --dispatch <dispatch_id> --json
orca orchestration worker-release --dispatch <dispatch_id> --json
```

Rules:

- Retry never inherits placement silently.
- `worker-abandon` fences orchestration without claiming or causing remote/process/filesystem effects.
- `worker-stop` closes only the proven supervised agent terminal; it never deletes the worktree, setup terminal, configured tabs, or unrelated processes.
- `worker-release` is idempotent and archives output before closing the exact owned terminal.
- If release returns `release_pending` or `release_unknown`, follow its exact recovery receipt. Never substitute `terminal close`.
- Reset is destructive recovery only; never run it during active coordination unless the user explicitly abandons that state.

### `references/low-level-topology.md`

Entry condition: `worker-start` cannot express required custom argv or terminal topology.

```bash
orca terminal create --worktree active --title <task-name> --command "<agent-command>" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration dispatch --task <task_id> --to <handle> --inject --json
```

Rules:

- Wait for readiness before injecting only when startup could lose the prompt.
- An operator-created terminal attached with `dispatch --inject` remains unsupervised. `worker-stop`, `worker-abandon`, and `worker-release` do not own or close that process.
- Use `worker-start --terminal <handle>` when supervised lifecycle ownership is required.
- Never use this path for a full handoff.

### `references/legacy-contract-migration.md`

This reference preserves the full current migration contract and should be loaded only when an authority label, adopted Run, compatibility recovery receipt, or explicit legacy takeover is present.

Its opening rules must remain verbatim in meaning:

- `[LEGACY COMPATIBILITY]`: live and attested; run only the exact printed command with the same selected executable and arguments.
- `[LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]`: one bounded at-least-once replay; process idempotently and acknowledge only as instructed.
- `[LEGACY READ-ONLY]`: inspection only; no reply, acknowledgment, or lifecycle mutation.
- An explicitly selected current Run, current binding, current Dispatch, or federated attachment takes precedence over legacy fallback.
- Unproven liveness, principal ownership, capability, or contract degrades to read-only inspection; it never falls back to local mutation.
- Adoption preserves the live process, PTY/session, terminal, tab/pane, workspace, Task, and Dispatch. It never restarts the worker or revives the retired scheduler.

Required takeover recipe:

```bash
orca orchestration run-use --id <adopted_run_id> --takeover-legacy --json
orca orchestration check --run <adopted_run_id> --json
```

Takeover runs only from the new live coordinator terminal when the original coordinator is unavailable or cannot prove authority. It fences the old coordinator, not workers. Do not take over an actively coordinated Run.

On packaged Windows, preserve the status-75 two-step legacy ask protocol and run the exact printed `ask --resume <message_id>` command. For an attested WSL launch, preserve the printed `orca-ide` executable and distro route. Never translate structured recovery arguments from memory.

## Command recipe index

| Goal                          | Canonical command                                                                       | Load first when conditional               |
| ----------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- |
| Create coordination namespace | `orca orchestration run-create --objective "<text>" --json`                             | Kernel                                    |
| Create work                   | `orca orchestration task-create --spec "<text>" --json`                                 | Kernel                                    |
| Start normal worker           | `orca orchestration worker-start --task <id> --worktree current --agent <agent> --json` | Kernel                                    |
| Start remote worker           | `worker-start ... --on <environment> --worktree new-top-level --repo <exact-selector>`  | `placement-and-remote.md`                 |
| Wait for actionable mail      | `check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json`     | Kernel                                    |
| Answer worker                 | `reply --id <message_id> --body "<answer>" --json`                                      | Kernel                                    |
| Guide one attempt             | `send --to dispatch:<dispatch_id> ... --json`                                           | `messaging-and-gates.md`                  |
| Inspect lifecycle             | `worker-show --dispatch <dispatch_id> --json`                                           | `recovery-and-cleanup.md`                 |
| Read output                   | `worker-read --dispatch <dispatch_id> --limit 50 --json`                                | `recovery-and-cleanup.md`                 |
| Retain settled terminal       | `worker-retain --dispatch <dispatch_id> --json`                                         | `recovery-and-cleanup.md`                 |
| Release settled terminal      | `worker-release --dispatch <dispatch_id> --json`                                        | Kernel                                    |
| Retry proven failure          | `worker-start --retry-of <old> ...` with explicit placement                             | `recovery-and-cleanup.md`                 |
| Custom topology               | `terminal create` then `dispatch --inject`                                              | `low-level-topology.md`                   |
| Full handoff                  | Invoke `orca-cli`                                                                       | Never load orchestration lifecycle detail |

## Anti-patterns

| Anti-pattern                                                             | Why it fails                                                               | Correct condition                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Spawn a generic subagent and call it Orca orchestration                  | No Run/Task/Dispatch provenance, injected authority, or durable settlement | When coordination state matters, use Orca `task-create` plus `worker-start`            |
| Create Task/Dispatch state for a full handoff                            | Invents a coordinator and monitoring obligation the user did not request   | Route ownership transfer to `orca-cli` and stop monitoring                             |
| Teach low-level `terminal create + dispatch --inject` as the default     | Produces an unsupervised process and duplicates lifecycle mechanics        | Use `worker-start`; load low-level topology only for an expressiveness gap             |
| Start waiting before all independent workers                             | Serializes independent work                                                | Create Tasks and start the full ready wave before the first wait                       |
| Treat a wait timeout or TUI idle as completion/failure                   | Observation is not settlement                                              | Keep waiting or inspect; preserve unknown state                                        |
| Retry because a remote endpoint disappeared                              | Contact loss does not prove exit and may duplicate editing                 | Render `unverifiable`; recover only from positive evidence or explicit operator choice |
| Release on heartbeat, timeout, question, escalation, or stale report     | Can close a live worker                                                    | Release only after accepted settlement                                                 |
| Use `terminal close` when release is uncertain                           | Bypasses ownership fencing and may close user resources                    | Follow the exact release recovery receipt                                              |
| Ack a Delivery before processing all rows                                | Whole-batch ack can hide unprocessed actionable mail                       | Process every row and resource decision, then ack                                      |
| Re-send an `ask` after timeout                                           | Creates duplicate question threads                                         | Resume the original message ID                                                         |
| Send lifecycle messages to `@all` or a provider group                    | Lifecycle belongs to one Dispatch                                          | Omit `--to` as a worker; use `dispatch:<id>` for coordinator guidance                  |
| Guess provider session IDs, transcript paths, or remote terminal handles | Breaks source/host identity fencing                                        | Use `worker-read` and Dispatch routing                                                 |
| Create a new Run from a nested worker to bypass depth                    | Depth follows the terminal's active Dispatch                               | Respect `nested_worker_depth_exceeded`; finish locally or escalate                     |
| Replace a legacy worker after update because authority is unclear        | Risks two editors on one filesystem                                        | Keep the original editor; use read-only inspection until a stable handoff              |
| Use raw JSON heartbeat payloads in taught recipes                        | PowerShell quoting is fragile and typed flags exist                        | Use `--task-id`, `--dispatch-id`, and `--phase` from the injected contract             |

## Migration and compatibility notes

### Preserve the discovery stub

Keep the safe executable resolver unchanged:

1. `ORCA_CLI_COMMAND` when set.
2. `orca-dev` only when `ORCA_DEV_REPO_ROOT` selects the dev checkout.
3. `orca-ide` on Linux outside an Orca-managed terminal, avoiding the GNOME screen reader.
4. `orca` otherwise.

The stub must load the version-matched guide before any orchestration mutation and keep the bounded read-only fallback for binaries that explicitly report `skills get` as unknown.

### Deliver references atomically or do not reference them

Preferred migration:

1. Add a versioned guide-package format containing `SKILL.md` and its references.
2. Make installation/materialization atomic and scoped to the exact CLI build.
3. Keep `orca skills get orchestration` backward-compatible by printing the compact main file.
4. Add a capability or explicit subcommand for retrieving reference content; do not infer package support from version strings.
5. For older clients, serve a flattened compatibility guide containing the kernel plus legacy reference.

If this is too large for the skill-only change, ship a compact single-file rewrite first. Use `orca orchestration <command> --help` as the late-loaded command source and retain migration details in a collapsed final section.

### Preserve current CLI and preamble contracts

- Do not rename Runs, Tasks, Dispatches, `worker_done`, or current status values in the skill rewrite.
- Keep old injected preambles valid for their active Dispatch. New Dispatches use the current grammar.
- Keep `worker_done` settlement automatic and exactly-once from the active worker terminal.
- Preserve explicit `--outcome succeeded|failed`, Task/Dispatch IDs, files, and optional report path.
- Keep task failure circuit breaking and nested-depth semantics unchanged.
- Keep low-level dispatch recognized as unsupervised; documentation must not imply resource ownership retroactively.

### Preserve mixed-version and remote wire behavior

- New fields remain optional. Old peers may omit them without being treated as failed.
- New stream opcodes require advertised capability; unknown opcodes may be dropped silently.
- A current Run remains authoritative on its home server. `--on` selects only worker placement, not the Run home.
- Address cross-server follow-ups, reads, stop, and cleanup through the Dispatch; do not send remote terminal handles across the boundary.
- Remote host loss yields `unverifiable`. Never synthesize process death from client inventory, relay absence, or timeout.
- Keep folder workspaces and non-Git tasks operational. Git lineage guidance must be conditional on a Git worktree actually existing.

### Migrate prose tests by invariant

Keep the current incident-backed assertions, but relocate them with ownership:

| Existing tested contract                                  | New owner                                    |
| --------------------------------------------------------- | -------------------------------------------- |
| Real Orca provenance and no generic subagent substitution | `SKILL.md` authority floor                   |
| Long waits are checkpoints                                | `SKILL.md` safe failure + recovery reference |
| Full handoff does not create lifecycle state              | `SKILL.md` classifier + `orca-cli` tests     |
| Review-only and named-next-owner boundaries               | coordinator reference                        |
| Exactly-once completion and post-completion idle          | worker reference and preamble tests          |
| Reuse/retain/release after accepted settlement            | `SKILL.md` completion + recovery reference   |
| No release from idle/timeout/heartbeat                    | recovery reference                           |
| Agent-first placement and handle recovery                 | placement reference                          |
| Legacy adoption/read-only/takeover                        | legacy reference                             |
| Version-matched safe resolver                             | discovery-stub tests                         |

Add package tests that every inline required read resolves within the versioned skill package and that a missing reference blocks before its governed mutation.

## Acceptance tests and eval scenarios

Mechanical tests:

1. Frontmatter is identical between installed stub and served guide.
2. The stub performs no mutation before loading the version-matched guide.
3. Every referenced file is shipped and retrievable for the same runtime build.
4. The kernel contains the outcome, safe-failure floor, role classifier, canonical loop, and completion accounting.
5. Command snippets match current `--help`, including PowerShell-safe quoted CSV filters and typed worker lifecycle flags.
6. Legacy labels and exact-command rules remain present in the compatibility owner.
7. Remote references contain `live`, `unverifiable`, and `exited`, plus the no-local-fallback rule.

Behavioral evals should run on at least one strong concise model and one more literal model:

1. **Simple supervised pair:** creates one Run and two Tasks, starts both before waiting, processes all mail, and releases both workers.
2. **Full handoff neighbor:** routes to `orca-cli`, creates no Task/Dispatch, and stops monitoring.
3. **Worker completion:** uses injected IDs/capability, reports failure through `--outcome failed`, sends exactly once, then idles.
4. **Ask timeout:** resumes the original message ID rather than creating a second question.
5. **Fifteen-minute task:** treats rolling wait timeout as a checkpoint; does not retry, stop, or release.
6. **Remote relay loss:** reports `unverifiable`, performs no local substitute action, and does not launch a duplicate editor.
7. **Mixed-version remote:** omits unsupported optional fields and sends no unnegotiated operation.
8. **Folder workspace:** starts and supervises without invoking Git-worktree-only assumptions.
9. **Low-level custom argv:** loads the topology reference, labels the worker unsupervised, and does not claim cleanup ownership.
10. **Legacy read-only:** performs inspection only; no reply, ack, signal, focus, stop, or injection.
11. **Settled reuse:** transfers the exact agent terminal to a fresh Dispatch before acknowledging the prior Delivery.
12. **Release uncertainty:** follows `release_pending`/`release_unknown` recovery output and never calls `terminal close`.

## Rollout sequence

1. Refactor tests around owned invariants without changing the served guide.
2. Add versioned package/reference delivery or explicitly choose the single-file fallback.
3. Land the compact kernel and worker contract first; compare behavior against the current guide on the twelve evals.
4. Move placement, messaging, recovery, low-level topology, and legacy detail one owner at a time.
5. Keep the current flat guide as a compatibility fixture until old/new client and remote-server tests pass.
6. Remove duplicated prose only after its replacement owner and eval are green.

## Definition of done for the rewrite

The rewrite is complete when a new coordinator can execute the common path from the kernel alone, a dispatched worker cannot miss or misroute its completion obligation, conditional references load only at their acting boundary, and every current authority, cleanup, legacy, folder-workspace, SSH/WSL, federation, and mixed-version invariant has an owning test. A shorter file is not the success metric; fewer always-loaded decisions and one authoritative location per mechanism are.
