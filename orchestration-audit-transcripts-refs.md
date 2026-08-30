# Transcript and terminal-read architecture audit

This audit covers the Orca worker-output and native-chat readers, provider/session
adapters, terminal RPC/CLI, SSH federation and WSL handling, fleet observability,
and the analogous surfaces in Overstory, Paperclip, Herdr, and Gas Town. It is an
architecture note only; `orchestration-issues.md` and source code were not changed.

## Executive findings

- Orca has two deliberately different read products. Native Chat reads
  provider-authored JSONL (`src/main/native-chat/*`), while orchestration worker
  reads prefer that transcript and fall back to an exact PTY tail. A source identity
  and process-incarnation fence prevents a cursor from silently crossing a new
  process or transcript.
- The local, SSH-host, and federated paths now execute reads on the execution host.
  `orchestration.federationReadOutput` calls the remote runtime; old peers are
  fenced to terminal-only `federationRead`. Losing an SSH relay is
  `unverifiable`, never `exited`, and does not make a stop successful.
- Transcript support is intentionally provider-specific at the decode/resolution
  boundary (Claude/OpenClaude, Codex, Grok, OMP). Providers without a trustworthy
  path report explicit fallback reasons; `auto` may use PTY output. This is safer
  than treating every agent's JSONL as interchangeable, but the supported-agent
  registry and provider hooks remain a growing maintenance seam.
- The strongest reference pattern is a normalized event stream plus a durable,
  bounded log cursor. Overstory's adapter interface makes provider differences
  explicit; Paperclip's run-log store survives pod loss with a transparent object
  storage mirror; Herdr separates visible/recent/detection reads and has passive
  subscriptions; Gas Town combines a Claude JSONL watcher (opt-in) with a
  feed/audit event log and restart-first lifecycle. None provides Orca's
  cross-provider transcript/PTY cursor contract out of the box.

## Orca architecture (current)

### Provider transcript and native chat

`src/shared/native-chat-agent-support.ts` maps `claude` and `openclaude` to the
Claude decoder and exposes Codex, Grok, and OMP as separate transcript agents.
`nativeChatRequiresLocalTranscript` marks Grok/OMP as unable to work from a
remote Model-A SSH main because their hooks do not disclose a transcript path.
`src/shared/agent-session-resume.ts` is the provider-session authority: it
normalizes session ids/paths, captures Claude/Codex `transcript_path`, captures
Pi's `session_file`, and defines provider-specific resume argv.

`src/main/native-chat/session-file-resolver.ts` first probes an authoritative hook
path, then provider-specific roots (Claude project slugs; managed Codex home then
`CODEX_HOME`; Grok/OMP roots). Windows WSL paths are translated to a ranked
`\\wsl.localhost` path in `host-readable-transcript-path.ts`; a stopped distro is
reported as an FS-gate refusal, not a missing transcript. `transcript-tail-reader.ts`
does bounded tail reads, complete-line boundaries, 2 MiB record caps, malformed/
oversized counters, lifecycle decoding, and forward cursor paging.

`src/main/ipc/native-chat.ts` exposes desktop IPC read/subscribe. Subscriptions
have sender-scoped cleanup, generation-safe unsubscribe, an unflushed-session
pending frame, and a retry/poll loop (`transcript-watch.ts`) that handles delayed
first JSONL flushes, replacement, and WSL failures. Runtime RPC
`src/main/runtime/rpc/methods/native-chat.ts` reuses the same readers for mobile/web,
with a 40-message initial / 2,000-message maximum window and client-kind payload
caps. Thus native chat is agent-specific in decoding, but transport and lifecycle
semantics are agent-agnostic.

### Worker transcript-first output

`src/main/runtime/orchestration/worker-transcript-read.ts` resolves the exact
provider session captured after dispatch attach, reads an initial tail or an
8 MiB-bounded forward page, and bounds response messages through
`worker-transcript-payload.ts` (40 default/50 max messages, block/input/response
limits, local-image omission, dispatch-capability redaction). Failure reasons are
typed: `provider_unsupported`, `session_not_reported`, `transcript_missing`,
`transcript_unreadable`, or `transcript_parse_failed`.

`readExactWorkerOutput` (`orchestration-worker-output.ts`) defaults to transcript
when the session is exact, but `source: terminal` selects the PTY directly and
`auto` falls back with a reason. Cursors encode dispatch id, source, source identity,
and byte/stream position. Before and after the read, process incarnation, agent,
session key/id, and transcript path are compared; mismatches return
`source_changed`/`worker_identity_changed`. PTY fallback uses the bounded recent
buffer, redacts dispatch capability tokens, and preserves terminal status.

Released workers are read from the archive path (`orchestration-worker-archive-read.ts`)
instead of a dead PTY. This makes release/read a durable handoff, not a best-effort
screen scrape.

### Terminal RPC and CLI

`terminal.read` (`terminal-query-methods.ts`) is a unary RPC over
`runtime.readTerminal`, supporting a cursor, bounded limit, and a `screen` flag.
The CLI (`src/cli/handlers/terminal.ts`) rejects `--screen` + `--cursor` and checks
the response `source` so an older host that silently drops `screen` cannot return
the wrong question's accumulated output. `terminal.read` is provider-neutral: it
reads the runtime PTY tail/current screen, not a provider transcript. Recent output
is retained by `RecentPtyOutputBuffer` (64 KiB default), with larger durable
scrollback snapshots handled by provider/renderer serializers.

### SSH, federation, and WSL boundaries

`SshPtyProvider` and `SshPtyProviderOutputState` proxy PTY lifecycle/data through a
relay, track provider generations/incarnations, and expose capability probes for
agent-session claims and idempotent creates. Snapshot authority is explicitly false
for this provider; reconnect attaches and replays through source-activation leases.
`orchestration.federationReadOutput` executes the full transcript/PTY decision on
the home (execution) host and returns its runtime epoch. A pre-structured peer is
handled by `orchestration-worker-legacy-federated-read.ts`, which permits only
terminal reads and returns `remote_capability_unavailable`; a transcript cursor is
rejected rather than silently downgraded.

`inspectWorkerTerminal` and federation control use the liveness vocabulary
`live`/`unverifiable`/`exited`; unregistered providers or lost relay contact are
never evidence of death. This matches `docs/reference/ssh-execution-boundary.md`.
WSL transcript access is separately gated (`wsl-transcript-fs-*`): guest paths are
never opened as `C:\home\...`, distro homes are cached/ranked, and refusal is
retryable. The same resolver runs in the remote main, so SSH reads use the remote
home rather than the desktop user's home.

### Fleet observability and notifications

PTY data notifications are sequenced and flow-controlled in the relay; gaps trigger
provider snapshots where available. Runtime orchestration status is persisted in
the dispatch DB, and setup/status changes enqueue federation relay messages. Worker
show/read responses carry exactness, liveness reason, `agentWait`, source identity,
runtime epoch, fallback reason, and warnings. Desktop/mobile unread/notification
policy is intentionally downstream of terminal side-effect facts, not embedded in
the PTY provider.

## Reference products

| Product       | Transcript/output source                                                                                                                                               | Agent scope                                                                                                         | Default/fallback behavior                                                                                                                                      | Remote/fleet observability                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overstory** | `AgentRuntime` adapters; Claude hooks/JSONL today, planned headless `stream-json`; `metrics/transcript.ts` parses usage                                                | Provider-specific adapter (`claude`, `codex`, `pi`, `copilot`, `cursor`, etc.); interface is agent-agnostic         | Interactive tmux is legacy/default for some flows; headless stream-json is opt-in by runtime; tmux capture is a fallback/visibility path, not truth            | No built-in SSH/federation in the audited tree; event/log files (`session.log`, `events.ndjson`) are local and redacted                                  |
| **Paperclip** | Adapter `onLog` emits stdout/stderr/system chunks into `RunLogStore` NDJSON; result JSON and heartbeat events                                                          | Process/HTTP/plugin adapters are provider-specific behind one adapter contract; logs are provider-agnostic chunks   | Local-file log is default; optional S3 mirror is transparent fallback on local loss; throttled in-flight mirror is opt-in                                      | API/CLI heartbeat streams live logs and events; S3 finalize/in-flight mirror supports pod restart, but remote workspace preview is explicitly refused    |
| **Herdr**     | In-memory Ghostty terminal state; `pane.read` sources `visible`, `recent`, `recent-unwrapped`, `detection`; alt-screen reads scroll only while agent idle              | Read API is agent-agnostic; agent metadata/session hooks are provider-aware                                         | `pane read` defaults to recent text; passive subscriptions poll and emit output/agent-status/scroll events; tmux/terminal attach remains transport             | SSH `--remote` runs a Herdr server on the target and forwards the local socket; no transcript-file protocol, so reads stay execution-host terminal state |
| **Gas Town**  | tmux is universal transport; optional `gt agent-log` tails Claude `~/.claude/projects/*/*.jsonl` into OTel `agent.event`; `.events.jsonl` records lifecycle/feed audit | Transcript watcher is Claude-specific; runtime/provider integration is generic at config level and defaults to tmux | `GT_LOG_AGENT_OUTPUT=true` + OTel URL opt-in; otherwise screen/tmux and lifecycle hooks; restart-first session management and `gt prime` handoff are fallbacks | Feed/audit NDJSON has visibility levels and run-id correlation; no general SSH transcript reader (remote use is via tmux/host process)                   |

### Actionable patterns from references

1. **Make provider variation a narrow adapter contract (Overstory).** Keep
   `resolveSessionFilePath`, line decoding, resume argv, and capability claims in a
   registry; do not broaden a generic reader to guess foreign JSONL. Add a provider
   conformance fixture whenever a new decoder is admitted.
2. **Persist a bounded, cursorable canonical log (Paperclip).** Orca's released
   archive already does this for workers. Extend the same contract to optional
   in-flight mirroring (local append remains hot; mirror at a cadence and flush on
   graceful shutdown) so a runtime/relay crash does not erase the tail before
   release. Preserve `sourceIdentity` and `nextCursor` across object-store reads.
3. **Separate read intent/source and passive subscriptions (Herdr).** Keep
   `terminal.read` (current screen vs accumulated tail) distinct from transcript
   `workerRead`; expose an explicit passive/watch mode for fleet dashboards rather
   than polling an interactive endpoint. Consider an `outputMatched` subscription
   for readiness/blocker detection, with provider status as a separate stream.
4. **Correlate lifecycle and content with a run id (Gas Town).** Add a stable
   dispatch/run correlation to archive records and observability events, and expose
   feed-vs-audit visibility. Keep agent output opt-in/redacted; never put capability
   tokens or secrets in logs.
5. **Treat execution-host reads as authoritative.** Herdr's remote mode and Orca's
   federation both forward the operation to the host owning the PTY/filesystem. Do
   not attempt desktop-side transcript path reads for SSH or WSL and do not infer
   process death from a broken transport.

## Proposed implementation slices (DAG)

The slices are deliberately small and can land independently. Dependencies are
listed as `A -> B` (A must land first).

- **A — Contract inventory and fixtures.** Freeze the current source/fallback
  vocabulary, cursor envelope, provider-session metadata, and archive record shape;
  add one fixture per supported transcript agent plus an unsupported-agent fixture.
  **Depends on:** none.
- **B — Provider adapter registry.** Introduce a typed registry that owns transcript
  decoder, resolver roots, lifecycle decoder, and `requiresLocalTranscript`; wire
  existing functions through it without changing behavior. **A -> B.**
- **C — Durable worker-log mirror.** Add an optional local-file/object-store mirror
  for in-flight worker archives, with cadence, graceful flush, stale-upload fencing,
  bounded range reads, and the existing source identity in the cursor. **A -> C.**
- **D — Passive output watch RPC.** Add a capability-negotiated stream/subscription
  for worker output/status (append frames + gap/replacement + liveness reason),
  keeping `workerRead`/`terminal.read` unary semantics unchanged. **A, B -> D.**
- **E — Federation compatibility matrix.** Add a host capability bit for structured
  worker output and tests covering new peer, old peer, relay loss (`unverifiable`),
  WSL refusal/recovery, and source/cursor changes. **A, D -> E.**
- **F — Fleet observability projection.** Project dispatch/run id, host id/epoch,
  source, cursor range, fallback reason, warnings, and liveness into redacted
  diagnostics/notifications with feed-vs-audit policy. **C, D, E -> F.**

## Non-goals and guardrails

- Do not make every provider's transcript format look identical, or infer a
  transcript path from an untrusted session id when the provider does not publish
  one.
- Do not replace PTY reads with transcript reads for interactive terminal UX;
  alternate-screen/current-frame semantics and ANSI output remain terminal-owned.
- Do not read SSH/WSL files from the desktop process, copy whole transcripts over
  the wire, or treat relay loss as process exit.
- Do not add a new stream opcode without capability negotiation and an old-client
  fallback; optional fields are preferred for mixed-version peers.
- Do not log raw prompts, tool payloads, image paths, dispatch capabilities, or
  provider credentials. Keep limits and redaction at the execution boundary.
- Do not require Git/tmux or a git worktree for folder workspaces; transcript
  resolution is runtime-relative.

## Verification tests

Existing high-value coverage includes:

- `src/main/native-chat/transcript-reader.test.ts`, `transcript-tail-reader-cancellation.test.ts`,
  `transcript-watch-{resolve-poll,unflushed-settle,liveness,error,unsubscribe-race}.test.ts`;
  `session-file-resolver-{codex-roots,wsl,wsl-scan-gate}.test.ts`; and
  `host-readable-transcript-path*.test.ts` for bounded parsing, delayed flush,
  replacement, cancellation, WSL ranking, and refusal recovery.
- `src/main/runtime/rpc/methods/orchestration-worker-output.test.ts`,
  `orchestration-federation-output.test.ts`, `orchestration-federation.test.ts`,
  and release/archive tests for source selection, redaction, cursor fencing,
  old-peer fallback, archive reads, and liveness semantics.
- `src/main/runtime/rpc/methods/terminal-read-screen-cursor.test.ts` and
  `src/cli/handlers/terminal.ts` characterization tests for screen/cursor
  validation and mixed-version `source` detection.
- `src/main/providers/ssh-pty-provider*.test.ts` and relay PTY publication/
  differential tests for incarnation, reconnect, notification gaps, flow control,
  and provider-generation teardown.

Tests required for the proposed slices:

1. Registry conformance: each supported decoder parses fixture lines; unsupported
   agents produce `provider_unsupported`; OpenClaude shares Claude format without
   changing identity; malformed/oversized lines are bounded and warned.
2. Cursor/source races: append while reading, truncation/rotation, process
   replacement, provider-session path change, archive handoff, and old cursor reuse
   must return `source_changed` rather than duplicate or cross-lane data.
3. Cross-host matrix: local, SSH, federated-new, federated-old, WSL guest path,
   cold/stopped distro, relay disconnect/reconnect; assert execution-host reads,
   `live`/`unverifiable`/`exited`, and no false stop success.
4. Durability: in-flight mirror cadence, failed upload retry, graceful flush,
   finalize-vs-stale-upload ordering, local-missing object fallback, range cursor,
   and response-size/redaction limits.
5. Passive watch: initial snapshot, append, gap/replacement, unsubscribe and sender
   teardown, capability-negotiated downgrade, and notification backpressure.
6. Fleet projection: stable dispatch/run/host correlation, feed-vs-audit filtering,
   no secrets/capabilities in diagnostics, and dashboard behavior when liveness is
   `unverifiable`.

## Reference paths consulted

- Orca: `src/main/native-chat/*`, `src/main/runtime/orchestration/worker-transcript-*`,
  `src/main/runtime/rpc/methods/{orchestration-worker-output,orchestration-worker-control,orchestration-federation-control,terminal/terminal-query-methods}.ts`,
  `src/cli/handlers/terminal.ts`, `src/main/providers/ssh-pty-provider*.ts`,
  `src/shared/{native-chat-agent-support,agent-session-resume,pty-liveness-verdict}.ts`,
  and `docs/reference/{ssh-execution-boundary,remote-wire-compatibility,wsl-command-execution}.md`.
- Overstory: `docs/runtime-adapters.md`, `docs/runtime-abstraction.md`,
  `docs/direction-ui-and-ipc.md`, `docs/headless-hooks-design.md`,
  `src/runtimes/*.ts`, `src/metrics/transcript.ts`, `src/events/*`, `src/logging/*`.
- Paperclip: `server/src/services/run-log-store.ts`, `run-liveness.ts`,
  `heartbeat-run-summary.ts`, `adapters/process/execute.ts`, `adapters/types.ts`,
  `cli/src/commands/heartbeat-run.ts`, and `server/src/__tests__/heartbeat-*.test.ts`.
- Herdr: `src/api/schema/{panes,agents,common}.rs`, `src/server/{headless,alt_screen_read}.rs`,
  `src/api/subscriptions.rs`, `src/terminal/history_read.rs`, `src/remote/attach.rs`.
- Gas Town: `internal/session/{lifecycle,agent_logging_unix}.go`,
  `internal/events/events.go`, `docs/agent-provider-integration.md`,
  `docs/design/polecat-lifecycle.md`, and `docs/otel-data-model.md`.
