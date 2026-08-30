# Orchestration CLI ergonomics evidence gate

## Decision status

**Closed: insufficient independent-trial evidence; no aliases or renames.** This
artifact froze the protocol, variants, answer key, and compatibility gate before
results were available. No fresh participant trial could be scheduled within
this gate, so behavioral thresholds are unmet by definition; repo-native static
evidence is reported separately and is not presented as a user study.

The benchmark targets the five workflows required by the vNext audit: one
worker, fan-out/join, ask/resume, a prompt queued during a busy turn, and
uncertain remote recovery. It compares discoverability without weakening the
current authority, idempotency, execution-host, or mixed-version contracts.

## Variants

Each participant sees one arm only. Do not describe another arm or reveal the
answer key before the trial.

| Arm           | Surface                                                                                                               | Purpose                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| A — current   | Current source grammar and current terse output/help.                                                                 | Baseline.                                   |
| B — wording   | Identical grammar, with the evidence wording below and exact next commands.                                           | Isolate wording from command-shape effects. |
| C — candidate | B wording plus the proposed `work start`, `wait --attention`, `status`, `worker-recover`, and `worker-retry` surface. | Test nouns/aliases before implementation.   |

Arm A means the current worktree source, not the installed production binary.
The installed app used during protocol preparation predates
`worker-start --spec` and terminal prompt receipts, while this worktree already
contains those additive changes. Participant cards are therefore authoritative;
do not let an older installed `orca --help` silently redefine the arm.

### Arm B wording

- Busy prompt accepted: `Queued for the agent's next turn. No resend is needed.`
- Ask timeout: `Question is still pending. Resume waiting; do not ask again:`
  followed by the exact `ask --resume <message_id>` command.
- Remote contact loss: `Connection lost; process status is unverifiable. Do not
retry until the old worker is proven stopped or explicitly abandoned.`
- Delivery wait: `--types chooses which new message wakes this wait. Orca still
returns the oldest complete replayable delivery; process all rows before
acknowledging it.`

### Arm C candidate definitions

The candidate card must define behavior rather than rely on suggestive names:

- `orchestration work start --spec ...` means atomic Task creation plus
  `worker-start`; it does not replace standalone Task creation for DAGs.
- `orchestration wait --attention` means wait on the current Run for questions,
  escalations, accepted completions, proven failures, or an uncertain outcome.
  It returns the oldest complete replayable delivery and does not hide older
  rows. It does not enable desktop notifications, focus a terminal, or inspect
  all Runs.
- `orchestration status` means a read-only, current-Run, attention-first fleet
  projection; `--tree` adds dependency/parent edges.
- `worker-recover` is read-only diagnosis. It never reconnects, stops, abandons,
  or retries by itself.
- `worker-retry --dispatch <id>` creates a linked new attempt only after the old
  outcome is settled and still requires explicit placement.

These are semantic proposals, not assumptions that the existing alias resolver
can implement them.

## Trial setup

- Use fresh independent agent sessions with no prior orchestration-vNext
  transcript. Minimum useful sample: six participants per arm; nine per arm is
  preferred. If fewer than six complete an arm, report descriptive results only
  and do not approve aliases.
- Balance provider/model across arms. Randomize scenario order with a Latin
  square. Keep IDs, prose lengths, topology, and simulated response delays
  identical between arms.
- Give the participant its arm card and one scenario at a time. It may request
  command help. Record each help request before returning only that command's
  arm-specific help.
- The trial is a command-planning simulation. Do not execute mutations against
  the active development Run. The participant emits commands and a one-sentence
  prediction of each command's effect; the harness returns the scripted receipt.
- Start the timer when the complete scenario becomes visible. Stop
  time-to-first-correct-command when the first command that is both syntactically
  valid for that arm and semantically safe for the fixture is emitted.
- Continue until the scenario reaches its terminal condition or the participant
  requests coordinator intervention. Cap each scenario at 10 minutes and 12
  participant commands.

## Scenario cards

Use the text in this section verbatim except for arm-specific command-card
references.

### S1 — one supervised worker

> You are the coordinator of bound Run `run_bench`. Start one fresh Codex worker
> in the current folder workspace to “review authentication fallback handling”.
> The current workspace must be reused; do not create a worktree or a second Run.
> After the scripted accepted completion arrives, preserve its readable output
> and account for the worker terminal. Show every command you would run and state
> what it will do before running it.

Scripted facts: start succeeds with Task `task_auth` / Dispatch `dsp_auth`;
`check` later returns delivery `dlv_auth` containing accepted `worker_done`;
release archives then closes only the fresh owned agent terminal.

### S2 — fan-out and join

> In bound Run `run_bench`, create two independent Tasks, `api` and `ui`, then an
> `integrate` Task that depends on both. Start `api` with Codex and `ui` with
> Claude in the current git worktree before waiting. Start `integrate` only after
> both predecessors complete. Do not create another Run, another worktree, or
> infer success from terminal silence. Show every command and predicted effect.

Scripted facts: Task creation returns `task_api`, `task_ui`, and `task_join`;
the first delivery completes `api` and asks a question from `ui`; replying makes
`ui` complete in the next delivery; `task-list --ready` then exposes the join.

### S3 — ask timeout and resume

> You are dispatched worker `dsp_ask`. Ask your coordinator whether the legacy
> flag should be preserved, offering `preserve,remove`, and wait up to 30 seconds.
> The first wait times out with pending message `msg_ask`; the answer arrives
> later. Continue waiting without creating a second question. Show every command
> and predicted effect.

### S4 — busy-turn queued prompt

> Agent terminal `term_busy` is proven to be in the middle of a turn. Send
> “Keep the Git 2.25 fallback.” with Enter and observe for up to 10 seconds
> whether the provider submission occurs. The first receipt says the prompt is
> accepted and queued, but submission is not yet observed. A simulated transport
> disconnect then makes the next result ambiguous. Continue safely without
> adding the text or Enter twice. Show every command and predicted effect.

Scripted facts: the first receipt issues request `req_busy`; replay/observation
of that request later proves one submission and one new turn.

### S5 — uncertain remote recovery

> Dispatch `dsp_remote` was working on saved environment `linux-ci` when contact
> was lost. Its last process verdict is `unverifiable`; the remote process may
> still be live. Determine the state and present safe actions. The operator then
> chooses “retry only after the exact old worker is proven stopped”. Do not run a
> local fallback, kill by pane/title, or start a duplicate attempt while the old
> outcome is unknown. Show every command and predicted effect.

Scripted facts: diagnosis remains `unverifiable`; exact `worker-stop` later
returns proven `stopped`; the linked retry must explicitly name `--on linux-ci`,
an exact remote worktree selector, and an agent.

## Current-command answer key

Equivalent quoting and optional `--json` are accepted. Extra read-only
inspection is counted but not failed unless it changes the target or treats
advisory output as proof.

| Scenario | Required current commands / decisions                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1       | `orca orchestration worker-start --spec "review authentication fallback handling" --worktree current --agent codex`; `check --wait --types worker_done,escalation,question`; after processing accepted completion, `worker-release --dispatch dsp_auth`; acknowledge only after the release decision.                                                                                                                        |
| S2       | Three `task-create` calls, with `--deps '["task_api","task_ui"]'` on the join; start both ready branches before waiting; process every delivery, use `reply --id <question_id>` for the question, acknowledge whole deliveries, query `task-list --ready`, then `worker-start --task task_join ...`. No name/`--after` syntax exists in the baseline.                                                                        |
| S3       | `ask --question ... --options preserve,remove --timeout-ms 30000`; after timeout, `ask --resume msg_ask --timeout-ms ...`. Repeating `--question` is a duplicate.                                                                                                                                                                                                                                                            |
| S4       | `orca terminal send --terminal term_busy --text "Keep the Git 2.25 fallback." --enter --wait-submit 10`; after an ambiguous result, repeat the exact payload with `--retry-request req_busy` (and optionally `--wait-submit 10`). A fresh send without the request ID is a duplicate risk.                                                                                                                                   |
| S5       | `worker-show --dispatch dsp_remote`; do not infer exit or retry from contact loss; after the operator choice, `worker-stop --dispatch dsp_remote`, inspect the stop receipt, then `worker-start --task <original_task> --retry-of dsp_remote --on linux-ci --worktree <exact_remote_selector> --agent <agent>`. `worker-abandon` is a safe alternative only if the operator chooses to stop tracking without process action. |

Arm C accepts its defined composed commands when they preserve the same facts
and targeting. It does not accept `wait --attention` as a substitute for Task
creation, delivery acknowledgement, terminal release, or remote diagnosis.

## Capture template

Record one row per participant/scenario/arm. Preserve the timestamped transcript
or attach its path.

| Field                      | Definition                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ttfc_ms`                  | Prompt-visible timestamp to first correct command.                                                           |
| `commands_total`           | Every emitted CLI command, including read-only and help.                                                     |
| `mutations_total`          | Commands that would change orchestration/terminal state.                                                     |
| `retries`                  | Explicit recovery attempts, valid or invalid.                                                                |
| `duplicate_risks`          | New question/message/prompt/worker attempts where an existing identity should have been resumed or observed. |
| `wrong_target_actions`     | Any mutation aimed at another Run/Dispatch/host/workspace/terminal or an unsafe local fallback.              |
| `help_lookups`             | Number and command path of help requests.                                                                    |
| `interventions`            | Coordinator corrections needed to proceed.                                                                   |
| `completed`                | Scenario reached the answer-key terminal condition within limits.                                            |
| `prediction_correct`       | Participant correctly described each mutation before execution.                                              |
| `attention_interpretation` | Verbatim answer plus coded category below.                                                                   |

For all arms, finish with this comprehension probe before revealing results:

> Without running it, explain exactly what `orca orchestration check --wait
--attention` would watch, which Run(s) it covers, whether it filters returned
> rows, whether it acknowledges anything, and whether it changes desktop
> notifications or terminal focus.

Code the answer as:

- `U` — recognizes the flag is unsupported in the current arm.
- `W` — wake predicate on one bound Run, full oldest delivery still returned,
  no acknowledgement/notification/focus side effects.
- `F` — believes attention rows are silently filtered from the returned batch.
- `A` — believes it acknowledges/clears attention.
- `N` — believes it controls native notifications, unread badges, or focus.
- `G` — believes it watches all Runs/global fleet state.
- `O` — other or incomplete; preserve verbatim text.

Arm A's only correct answer is `U`. Arm B should also be `U` unless its card
explicitly introduces the flag. Arm C's correct answer is `W` only if the
candidate is narrowed to the existing mailbox contract. The broader audit
definition that also wakes on synthesized uncertain worker state is not an
alias: score that answer separately as `W+state` and require an implemented,
capability-safe event source before promotion.

The Arm C definition in this protocol is the broader form, so `W+state` is its
expected answer. `W` is recorded as a narrower interpretation, not silently
accepted as equivalent.

## Analysis and decision rule

Report per arm and scenario: completion proportion; median and range for
`ttfc_ms`, commands, and help; totals for duplicate risks, wrong targets, and
interventions; and the attention interpretation distribution. Keep raw counts
beside percentages because the intended sample is small.

Wording (B) may be adopted when it causes no new wrong-target or duplicate-risk
actions and improves at least one error/comprehension measure. It does not need
to reduce command count because its purpose is truthful interpretation.

No alias/rename from C is approved unless all of these hold:

1. Completion is non-inferior to both A and B, with no wrong-target actions.
2. Median time to first correct command improves by at least 20% versus B in at
   least three scenarios, including one of fan-out/join or remote recovery.
3. Total commands or help lookups improve in at least three scenarios without
   increasing retries, duplicate risks, or interventions in any scenario.
4. At least 90% of participants interpret its scope and side effects correctly;
   no participant mistakes `--attention` for acknowledgement or notification/
   focus policy.
5. The compatibility review below classifies the exact implementation as safe.

If results are mixed, keep the canonical commands and adopt only the successful
wording/help changes. Do not combine B and C results or attribute wording gains
to aliases.

## Compatibility review before any implementation

| Candidate                     | Compatibility finding                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Improved receipt/help wording | Additive and low risk if JSON fields, exit codes, stable status/verdict vocabulary, and exact recovery argv remain unchanged. Mixed-version output must state host capability honestly.                                                                                                                                                  |
| `work start`                  | Not a mechanical alias in the current parser: it changes command depth relative to `worker-start`, and existing alias-policy tests reject depth-changing aliases. Its proposed atomic semantics also do not cover DAG starts. Requires a real command handler and continued canonical support; benchmark gains must clear the full gate. |
| `wait --attention`            | Not a safe alias to `check --wait --types ...` if it includes uncertain worker state. Current type filters only decide wakeup while returning the oldest full delivery. A broader predicate needs additive runtime/RPC capability negotiation and mixed-version fallback.                                                                |
| `status`                      | Cannot be a blind alias to `worker-list`: current worker-list includes terminal-resource accounting, while the proposal is current-Run, attention-first work/worker state with dependencies. Keep `worker-list` stable.                                                                                                                  |
| `worker-recover`              | Can remain a new read-only composition over `worker-show` only if it performs no mutations and preserves `live` / `unverifiable` / `exited`. It must route reads to the execution host and degrade explicitly on old peers.                                                                                                              |
| `worker-retry`                | Not a synonym for `worker-start`: it must look up/link the prior Dispatch, reject unverifiable old liveness, require explicit host/worktree/agent placement, and preserve the existing `--retry-of` path for old clients.                                                                                                                |
| Task names / `--after`        | New Run-scoped identifiers and parsing, not aliases. IDs remain authoritative; old clients/hosts need ID-based fallback and duplicate/ambiguous names must fail before mutation.                                                                                                                                                         |
| Context-bound `done`          | Authority-sensitive new behavior, not a rename. Zero or multiple active Dispatch roles must fail closed; the explicit `send --type worker_done --task-id ... --dispatch-id ...` contract remains canonical and mixed-version safe.                                                                                                       |

## Repo-native discoverability and command-floor evidence

This section is objective implementation evidence, not a substitute for the
independent participant benchmark.

The worktree CLI was rebuilt successfully with `pnpm run build:cli`, then queried
through `node out/cli/index.js` so the measurements include the current source
rather than the older installed app.

### What the current registry exposes

- `agent-context` reports 233 total commands and 30 orchestration commands.
  None of the scenario commands has an alias or an example. The only two
  orchestration aliases are `run` and `run-stop`, both attached to retired
  no-effect compatibility commands.
- `worker-start --help` exposes atomic `--spec`, but its usage has 27 flags and
  eight notes. This already removes the Task-ID plumbing for S1, so `work start`
  cannot reduce S1's command count.
- `task-create --help` exposes `--deps <json_array>` with no note or example.
  Fan-out/join therefore has a specific documentation gap; changing the noun
  does not teach dependency ordering.
- `ask --help` explicitly says a timeout leaves the question pending and to
  resume with the original message ID. Its current non-JSON timeout output,
  however, prints only the thread and elapsed time rather than the exact resume
  command.
- `terminal send --help` explicitly states that `--wait-submit` observes without
  resending and that ambiguous transport recovery reuses `--retry-request`.
  Human output currently prints stage names, not the proposed plain-language
  “No resend is needed” sentence.
- `worker-show --help` explains interactive-wait evidence but does not present
  the `live` / `unverifiable` / `exited` recovery decision. Its human formatter
  omits process liveness and ordered recovery actions, so S5 currently depends
  on JSON or skill guidance.
- `worker-list` already prints projected attention categories, but an omitted
  `--run` queries all Dispatches and the command is described as terminal
  resource accounting. A proposed current-Run `status` view is therefore not an
  alias-equivalent spelling.
- The global and command-specific help disagree about retired coordinator
  commands: global help still describes `coordinator-start` as starting a legacy
  loop, while orchestration help correctly says it is retired. Its intuitive
  `orchestration run` alias performs no effects and returns skill recovery.
- `orchestration check --help` incorrectly borrows the screenshot flag label for
  `--format`, displaying `--format <png|jpeg> Screenshot image format`; the same
  help page's note correctly says it locally renders message rows. This is a
  concrete wording defect that can be repaired without inventing a new noun.

### Unsupported-candidate behavior

Each proposed noun currently exits 1 as unknown. `work start`, `wait`,
`status`, `worker-recover`, and `worker-retry` print 365–366 lines of global
help with no nearest-command recovery. `check --attention --peek --json` fails
locally with `Unknown flag --attention`, lists 17 valid flags, and offers no
suggestion. This establishes a discoverability cost in the current CLI but does
not establish that these particular nouns are the remedy.

The current alias resolver canonicalizes an exact alias before validation and
dispatch, so same-semantics/same-depth aliases can safely share a handler. The
vocabulary-policy test deliberately rejects aliases at a different command
depth. `work start` is one token deeper than `worker-start`, and the candidate
recovery/status commands have different behavior, so none qualifies as a
mechanical alias under the existing compatibility mechanism.

### Static CLI command floor

| Scenario |                                   Current A/B floor |       Candidate C floor | Finding before participant timing                                                                                                      |
| -------- | --------------------------------------------------: | ----------------------: | -------------------------------------------------------------------------------------------------------------------------------------- |
| S1       |       4: start, wait, release, acknowledge/continue |                       4 | `work start` changes spelling only.                                                                                                    |
| S2 setup |           5: create three Tasks, start two branches |                       5 | Names/`--after` avoid ID extraction but do not remove a CLI command. A combined status view may later remove one read, not a mutation. |
| S3       |                                      2: ask, resume |                       2 | Wording is the proposed intervention; no alias is needed.                                                                              |
| S4       |  2: accepted send, identity-bound retry/observation |                       2 | Wording is the proposed intervention; no alias is needed.                                                                              |
| S5       | 3: show, exact stop, explicitly placed linked start | 3: recover, stop, retry | Candidate nouns do not reduce actions and must not hide placement or uncertainty.                                                      |

Thus the candidate arm has no pre-trial command-count advantage in four complete
scenarios or in S2 graph setup. Any case for it must come from measured time,
help, or targeting accuracy and still clear the compatibility gate.

The spelling-only savings are also uneven: `worker-start` is 12 characters and
`work start` is 10 but adds a command token; `worker-show --dispatch dsp_remote`
is three characters shorter than `worker-recover --dispatch dsp_remote`.
`wait --attention` is materially shorter than the 52-character explicit wait
filter, and a composed retry can be shorter while retaining explicit placement.
Those two cases remain semantic compositions, so timing/comprehension—not string
length—must justify them.

### Remote and mixed-version boundary

- Direct SSH loss disconnects Orca's client-resident control plane while the
  execution-host PTY may remain live. A recovery noun cannot imply reconnect or
  exit; only host evidence may change `unverifiable` to `live` or `exited`.
- Paired runtimes update independently. An optional response field is safe only
  while every reader treats absence as unknown. New behavior that depends on a
  field or event requires capability negotiation and a safe old-peer fallback.
- A broad `--attention` sent to an older host would otherwise be especially
  hazardous: an old decoder may strip an unknown optional parameter, leaving a
  new client waiting under ordinary message semantics while believing worker
  outcome state is included. Promotion needs an advertised wait capability or
  a client-side composition whose partial-host coverage is explicit.
- The current tree already has narrow capabilities for prompt delivery, worker
  stop verdicts, federated fleet snapshots, structured remote reads, and remote
  release. Candidate wording must expose their typed downgrade; it must not
  silently run a remote operation on the desktop or reuse a local worker.

### Validation state observed during protocol preparation

The focused alias parser and vocabulary tests passed. The combined focused run
finished 77 of 81 tests green, with one live registry-parity failure because
`worker-cleanup` is exposed by the spec but absent from the handler registry,
plus three lifecycle-check failures where current shared-worktree settlement
could not find a worker row. These failures are outside the benchmark artifact,
but they mean the current merged tree is not a safe base for speculative command
surface changes until its existing registry/lifecycle integration is green.

The scenario-specific current grammar is independently green: the worker-start,
terminal-send, timeout/resume, worker-show wait, and durable prompt receipt suites
passed 49 of 49 tests. The failing integration checks above therefore do not
invalidate the S1/S3/S4/S5 answer-key syntax, but they still block promotion of a
new public surface in this shared tree.

## Results

No independent participant completed an arm (`n=0` for A, B, and C). The
coordinator explicitly chose to close this gate as insufficient evidence rather
than substitute a single evaluator's self-timed dry run.

| Required measure              | Result                                                                                                                                                                    | Decision use                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Time to first correct command | Not measured; no valid participant timing sample.                                                                                                                         | Cannot support a new noun.                            |
| Command count                 | Static mutation/read floors measured above. Candidate C removes no command in S1, S3, S4, S5, or S2 setup.                                                                | No objective count benefit.                           |
| Retries / duplicate sends     | Scenario-specific current receipt/resume suites pass; no participant error rate was measured.                                                                             | Existing identities remain canonical.                 |
| Wrong-target actions          | No participant rate measured. Remote boundary analysis shows a candidate retry/recover composition could be unsafe if it hides host or placement.                         | Requires behavioral and skew trials before promotion. |
| Help lookups                  | No participant rate measured. Current-source discovery exposes zero examples for the seven scenario commands; unsupported candidates dump 365–366 lines of global help.   | Justifies testing focused help/wording, not aliases.  |
| `--attention` interpretation  | No participant comprehension sample. Current source rejects it; the narrow mailbox meaning and broad mailbox-plus-worker-state meaning require different implementations. | The flag remains unapproved.                          |

The evidence is sufficient to reject implementation now, not to claim that the
candidate labels are intrinsically worse. The follow-up protocol above remains
the promotion path: run balanced fresh sessions, preserve raw timestamps and
predictions, and apply the predeclared thresholds without combining wording and
alias effects.

## Final decision

Keep the current command grammar. Do not add `work start`, `wait --attention`,
`status`, `worker-recover`, `worker-retry`, Task-name/`--after`, or context-bound
`done` on this evidence. They either do not reduce the command floor or require
new semantics, authority checks, and mixed-version negotiation that cannot be
justified without behavioral gains.

No CLI noun, alias, flag, or command behavior was changed. A later wording-only
change may address the concrete help defects (`check --format`, retired
coordinator wording, exact ask-resume/no-resend guidance) after it is tested as
Arm B; it must preserve JSON, exit codes, stable verdicts, and emitted recovery
argv.
