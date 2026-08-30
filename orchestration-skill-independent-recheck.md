# Independent recheck: served Orca orchestration skill

Date: 2026-08-27
CLI/package: rebuilt `out/cli/index.js` from this worktree (`pnpm run build:cli`)
Runtime: `1.4.191-adhoc.20260827063356`, runtime id `f301d6bd-73eb-47ff-971a-ab8b10508f19`

## Acceptance checks

| Check                                            | Result | Evidence                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain output is materially smaller than `--full` | PASS   | `skills get orchestration`: 10,571 bytes / 171 lines; `--full`: 30,510 bytes / 630 lines (plain is 34.6% of full).                                                                                                                                                                                                                      |
| Full output starts with the kernel               | PASS   | `full.startsWith(kernel)` is true; both outputs begin with the orchestration frontmatter and `# Orca orchestration`.                                                                                                                                                                                                                    |
| All seven owned references resolve               | PASS   | Full output contains one marker and the complete body for each of `coordinator-loop.md`, `legacy-contract-migration.md`, `low-level-topology.md`, `messaging-and-gates.md`, `placement-and-remote.md`, `recovery-and-cleanup.md`, and `worker-contract.md`. Marker count is 7; kernel marker count is 0.                                |
| JSON/text parity                                 | PASS   | Parsed JSON `markdown` is byte-for-byte equal to plain text for both normal and `--full` retrieval; `full` flags are `false` and `true` respectively and topic names match.                                                                                                                                                             |
| Worker lifecycle recipes are capability-bound    | PASS   | Kernel reminder and `references/worker-contract.md` heartbeat and `worker_done` recipes all include `--from <worker_handle>`, `--dispatch-capability <capability>`, and `--task-id <task_id> --dispatch-id <dispatch_id>`. The current preamble values were used for a real heartbeat; it was accepted and updated `last_heartbeat_at`. |

## Scenario exercises

### Coordinator scenario

Simulated “supervise independent workers and wait for results” using the rebuilt
CLI against the existing Run without creating new state: `status --json`,
`task-list --run run_f61f3e3758e7 --brief --json`,
`task-list --run run_f61f3e3758e7 --ready --brief --json`,
`dispatch-show --task task_e6cd1bde4e26 --json`, and a one-millisecond
`check --wait --types worker_done,escalation,question --json` checkpoint all
returned valid JSON. The task list reported 24 tasks (the recheck task was
`dispatched`), the ready filter reported zero, dispatch-show identified the
active Dispatch, and the wait returned `count: 0, timedOut: true`; no effects
were applied. The kernel's loop and completion-accounting language was
unambiguous for this coordinator path.

### Worker scenario

Used this Dispatch's injected identity (`term_7bc13793-bc47-425a-83f9-634fbba47a15`,
`dcap_ihvtilM1D-v5fonojW-OodICzNK4nbXB-uMffoXUD24`,
`task_e6cd1bde4e26`, `ctx_4a21e1a6df30`) with the worker-contract heartbeat
recipe. The capability-bearing typed invocation succeeded (`ok: true`, message
type `heartbeat`, payload phase `reviewing`); a subsequent dispatch inspection
confirmed the Dispatch remained `dispatched` and its heartbeat timestamp
advanced. The worker_done recipe was checked statically (it is intentionally
not executed during an active recheck because it settles this Dispatch), and
its flags match the injected preamble contract and current `send --help`.

## Verdict

ACCEPTED. No stale, ambiguous, or capability-missing recipe was found in the
rebuilt served package; no source or skill files were edited.
