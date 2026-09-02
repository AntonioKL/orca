# Unify the pane-agent identity ladder

## Decision requested

Make `resolveCanonicalPaneAgentIdentity` the one ranking implementation used everywhere Orca
answers “which agent is in this pane”. Keep the six existing public entry-point signatures as thin
adapters, so the 65 consumer rows do not churn. This plan deliberately stops at design: no product
behavior or source file is changed by this task.

The companion review artifact is [ladder-unification-decision-table.md](./ladder-unification-decision-table.md).
It contains the exhaustive 648-shape table and the proof-freshness trap that must remain a test gate.

## Why this seam

Today the tab icon, open-tab occupant, host publication, pane owner, status ingress, and title
readers each rank overlapping evidence differently. The canonical adapter already has the right
shape for a shared seam: it accepts pane-scoped evidence, host-stamped process proof, run keys,
scope/floor options, and an uncovered fallback, and returns the answer plus provenance. Promote that
adapter from comparison-only code to the production resolver; keep its low-level evidence types in
`src/shared/pane-agent-identity-resolver.ts`, but make that module a private ranking primitive (or a
delegating compatibility export), never a second policy.

The local reference-repository review found the same useful boundary in mature terminal systems:
the execution host owns process identity and lifecycle, display titles are separate metadata, and
remote adapters forward opaque host evidence while tolerating missing optional fields. Orca should
apply those principles in its own vocabulary; no external project or implementation is copied.

## Canonical contract

`src/shared/pane-agent-identity-adapter.ts` owns this public input and output (the exact field names
can be retained from the existing adapter):

```ts
type CanonicalPaneAgentIdentityInput = {
  hookAgent?: TuiAgent | null
  hookIsLive?: boolean
  hookRun?: PaneAgentRunKey
  completedHookAgent?: TuiAgent | null
  completedHookRun?: PaneAgentRunKey
  launchAgent?: TuiAgent | null
  launchRun?: PaneAgentRunKey
  foregroundAgent?: TuiAgent | null
  processProof?: ForegroundProcessProof | null
  sleepingSessionAgent?: TuiAgent | null
  sleepingRun?: PaneAgentRunKey
  siblingAgent?: TuiAgent | null
  allowSibling?: boolean
  title?: string | null
  currentRun?: PaneAgentRunKey
  minimumSource?: PaneAgentEvidenceSource
  uncoveredFallback?: { agent: TuiAgent | null; titleOnly?: boolean }
}

type CanonicalPaneAgentIdentity = {
  agent: TuiAgent | null
  source: PaneAgentEvidenceSource | null
  coverage: 'covered' | 'uncovered'
  titleOnly: boolean
  ambiguousAt?: PaneAgentEvidenceSource
  supersededSources: readonly PaneAgentEvidenceSource[]
}
```

The resolver constructs evidence once and applies one order, strongest first:

1. `live-hook`: the provider reports its own identity for the focused pane.
2. `process`: only a fresh, name-matching `ForegroundProcessProof` stamped by the execution host.
3. `launch`: Orca's accepted launch/resume/command intent.
4. `completed-hook`: the last completed focused-pane hook for the current run.
5. `sleeping-session`: durable provider-session identity while a pane sleeps.
6. `sibling`: only when a tab-level caller explicitly opts in with `allowSibling`.
7. `title`: parsed vendor marker or anchored owner suffix, absolutely last.

Equal-rank conflicting observations return `agent: null` with `ambiguousAt`; array order must never
choose a winner. `currentRun` filters same-authority superseded evidence while treating missing or
cross-authority run keys as incomparable/eligible for mixed-version compatibility. A caller that
authorizes a write passes `minimumSource: 'launch'`, which excludes title and sibling evidence from
the decision rather than merely hoping a higher source happens to exist. `coverage` is based only
on eligible authority evidence (hook, fresh process proof, launch, completed hook, or sleeping
session), never on a title, sibling, or bare process name. An uncovered fallback preserves the old
answer only as a clearly marked compatibility lane; it cannot turn a title into covered proof.

The host proof contract remains strict: `ForegroundProcessProof` carries an opaque process
incarnation, authority id, `capturedAgeMs`, and `validForMs`. Missing, negative, non-finite, expired,
or name-mismatched fields drop the process rung. The decision-table test must fail if a fixture omits
either freshness field, because that silently turns 648 back into 2,520.

### What the 648 shapes decide

The companion table replays all `17,496` signal shapes and must reproduce 2,520 disagreements without
a proof and 648 with a fresh proof. The 648 residuals are:

- canonical `launch`: 612 (old result was a conflicting completed hook: 396, sleeping session: 144,
  or title: 72); the launch record wins all three because title is last and durable records outrank it;
- canonical `completed-hook`: 36 (old result was the opposite title); the completed hook wins;
- canonical `sleeping-session`, `process`, `sibling`, and `title`: zero.

When launch and foreground process disagree, a fresh host proof wins over launch. The 1,872 shapes
that change when the proof is supplied are exactly the process-starvation artifact; no residual 648
shape has a valid process proof. The separate process-selector fix for nested OMP/ChatGPT.app
descendants must land first and retain the WSL resolver's ambiguity fence: if the host cannot select
one foreground agent unambiguously, it emits no proof and the canonical resolver returns to launch,
hook, sleeping, or unknown instead of guessing.

## Six thin adapters and exact seams

The adapters preserve caller signatures and translate local fields to canonical evidence. None may
re-rank, parse a title beside the canonical call, or invent a process proof.

| Existing entry point | Current production seam | Thin-adapter behavior after migration |
| --- | --- | --- |
| `resolveTabAgentFromSignals` | Definition/ladder in `src/renderer/src/lib/tab-agent-from-signals.ts` (the branch may colocate it in `use-tab-agent.ts`); called by `src/renderer/src/lib/use-tab-agent.ts` and `src/renderer/src/lib/open-tab-occupant-agent.ts`. | Map focused live/completed hooks, launch, sleeping, host proof, title, and sibling slots to the canonical input and return `.agent`. Keep `resolveLaunchedAgentExitEvidence` as lifecycle evidence only; it must not alter ranking. `useTabAgent` supplies the host proof when present and keeps the existing `TuiAgent | null` return. |
| `resolvePaneAgentIdentity` | `src/shared/pane-agent-identity-resolver.ts`, called from `src/shared/published-pane-agent-identity.ts`. | Retain its generic evidence/result shape for tests and old imports, but delegate to the canonical implementation (or make its ranking routine private). There must be one `SOURCE_RANK`, one ambiguity rule, and one run-eligibility implementation. |
| `resolvePaneAgentOwner` / `resolvePaneAgentOwnerRecord` | Owner/record consumers: `src/renderer/src/lib/tab-agent-from-signals.ts`, `src/renderer/src/lib/use-tab-agent.ts`, `src/renderer/src/components/sidebar/worktree-title-derived-agent-rows.ts`, `src/renderer/src/components/terminal-pane/parked-terminal-command-status.ts`, `src/renderer/src/components/terminal-pane/pty-connection/shell-command-inference.ts`, `src/renderer/src/runtime/web-session-tabs-sync/terminal-build.ts`, `src/renderer/src/runtime/web-session-tabs-sync/agent-status-primitives.ts`, `src/main/runtime/runtime-mobile-agent-status-builder.ts`, and `src/main/runtime/runtime-mobile-session-projection.ts`. | Translate launch/startup/initial/typed-command fields to `launch` evidence while preserving `ownerIsLaunch`; map focused/sibling live and completed hooks and sleeping sessions to their canonical sources. Return the legacy `AgentType | null` or owner record without a second precedence list. Action users of this adapter use the canonical minimum-source floor. |
| `resolveAgentStatusIdentity` | Definition `src/shared/agent-status-identity.ts`; production ingress/builders in `src/main/agent-hooks/server.ts`, `src/main/agent-hooks/server/server-status-update.ts`, `src/renderer/src/hooks/ipc-events/agent-status-event-applicator.ts`, `src/renderer/src/store/slices/agent-status.ts`, and `src/renderer/src/store/slices/agent-status-live-entry-builder.ts`. | Keep status freshness, `unknown` normalization, and `inheritedFromActivePane`/child-completion suppression as status policy. Convert existing and incoming rows into live/completed hook evidence, call the canonical resolver, and map a null/ambiguous result back to the current status shape. No status-specific agent ordering remains. |
| `collectAgentTitleEvidence` / `resolveTerminalTitleAgentType` (including explicit/committed wrappers) | Parser definitions in `src/shared/agent-title-evidence.ts` and `src/shared/terminal-title-agent-type.ts`; direct identity consumers include `src/shared/published-pane-agent-identity.ts`, `src/renderer/src/lib/notes-send-agent-targets.ts`, `src/renderer/src/lib/open-tab-occupant-agent.ts`, `src/renderer/src/lib/tab-agent-from-signals.ts`, `src/renderer/src/lib/use-tab-agent.ts`, `src/renderer/src/lib/pane-agent-evidence.ts`, and `mobile/src/session/mobile-terminal-tab-agent.ts`. | Keep parsing as an evidence producer for activity/formatting and for the canonical title rung. Any caller answering pane identity passes the raw title to the canonical resolver and does not combine a title result with a launch/process result locally. Free-text-only and conflicting title evidence remain null; title is never primary. |
| `resolveCanonicalPaneAgentIdentity` | Existing adapter in `src/shared/pane-agent-identity-adapter.ts`; currently reached only by the comparison wrappers. | Make this the production call made by every adapter. Remove comparison-only callers, add direct canonical tests, and return provenance/coverage so displays can show an honest unknown while action callers can fail closed. |

The inventory ratchet remains authoritative: helper-name census rows 1–31 and marker-pinned surface
rows 6 and 32–65 must be updated deliberately whenever a wrapper moves or is renamed.

## Migration tranches (65 rows)

Every tranche keeps the old signature, changes only its adapter body, runs the inventory ratchet, and
records the canonical source/ambiguity behavior in focused tests before the next tranche. This order
puts rendered display blast radius first, then main/runtime behavior, and the host-to-client wire last.

### Tranche 0 — establish the seam (no consumer behavior switch)

- Promote `resolveCanonicalPaneAgentIdentity` and its `ForegroundProcessProof` freshness gate.
- Make `resolvePaneAgentIdentity` and the owner/status/title functions delegating adapters; keep
  parser-only uses classified as activity or formatting.
- Add the exhaustive decision-table fixture and canonical resolver tests (including equal-rank
  conflict, run-key supersession, missing proof, and title-last cases).
- Run `src/shared/pane-agent-identity-inventory.test.ts` and
  `src/shared/pane-agent-identity-surface-inventory.test.ts`; no row may disappear.

### Tranche 1 — renderer display surfaces (first behavior change)

Move display decisions to the canonical adapter in the tab icon/open-tab occupant and the marker
surfaces for rows 32, 48–52, and 61–65:

- `src/renderer/src/lib/use-tab-agent.ts`, `src/renderer/src/lib/tab-agent-from-signals.ts`,
  `src/renderer/src/lib/open-tab-occupant-agent.ts`;
- `src/renderer/src/components/terminal-pane/native-chat-leaf-title-agent.ts`,
  `src/renderer/src/components/terminal-pane/TerminalPane.tsx`,
  `src/renderer/src/components/terminal-pane/pty-connection/pane-agent-identity.ts`;
- `src/renderer/src/components/tab-bar/tab-agent-types-by-tab-id.ts`,
  `src/renderer/src/components/terminal-pane/terminal-tab-agent-type-index.ts`,
  `src/renderer/src/lib/tab-agent-status-index.ts`,
  `src/renderer/src/components/tab-bar/terminal-tab-activity-status.ts`;
- `src/renderer/src/lib/workspace-tab-agent-metadata.ts`,
  `src/renderer/src/lib/workspace-tab-palette-entry-builder.ts`,
  `src/renderer/src/lib/worktree-status.ts`,
  `src/renderer/src/components/sidebar/smart-attention.ts`,
  `src/renderer/src/components/status-bar/workspace-space-presentation.ts`, and
  `src/renderer/src/store/slices/terminal-helpers.ts`.

The adapter returns `null`/unknown for ambiguity and title-only provenance rather than changing a
title into a confident icon. Run the two inventory tests plus the tab, title, sidebar, status, and
worktree focused suites with the repository Vitest config.

### Tranche 2 — renderer actions and routing

Migrate action rows 33–47 and 53, 55–60, including:

- `src/main/runtime/orchestration/groups.ts`'s renderer-facing projection and
  `src/renderer/src/lib/active-agent-note-target.ts`;
- paste/output ownership and send paths in
  `src/renderer/src/components/terminal-pane/terminal-agent-paste-bracketing.ts`,
  `src/renderer/src/components/terminal-pane/command-code-output-ownership.ts`,
  `src/renderer/src/components/terminal-pane/pty-connection/command-inferred-pane-agent.ts`,
  `src/renderer/src/components/terminal-pane/pty-connection/agent-task-complete-notify.ts`,
  `src/renderer/src/components/terminal-pane/pty-connection/terminal-keydown-fit.ts`,
  `src/renderer/src/components/terminal-pane/pty-connection/pane-serializer-settle.ts`,
  `src/renderer/src/lib/active-agent-note-send.ts`,
  `src/renderer/src/components/native-chat/native-chat-runtime-send.ts`, and the mobile send
  adapters;
- readiness, follow-up, restart, native-chat, continuation/fork, keyboard, hibernation/resume,
  automation reuse, cold-restore, and title-spawn-bell surfaces identified by markers in
  `pane-agent-identity-surface-inventory.test.ts`.

Action adapters pass `minimumSource: 'launch'` (or a stricter source where appropriate), require a
current run when available, and fail closed on `null`/ambiguous/title-only identity. No command,
launch flag, or shim changes.

### Tranche 3 — renderer status, sync, and mobile projections

Migrate row 6 and the renderer half of row 59, plus row 54:

- `src/renderer/src/runtime/web-session-tabs-sync.ts`,
  `src/renderer/src/runtime/web-session-tabs-sync/terminal-build.ts`, and
  `src/renderer/src/runtime/web-session-tabs-sync/agent-status-primitives.ts`;
- `src/renderer/src/hooks/ipc-events/agent-status-event-applicator.ts`,
  `src/renderer/src/hooks/ipc-events/agent-status-routing.ts`,
  `src/renderer/src/store/slices/agent-status.ts`,
  `src/renderer/src/store/slices/pane-foreground-agent.ts`, and
  `src/renderer/src/store/slices/terminal-helpers.ts` where the marker pins identity reset;
- `src/renderer/src/runtime/sync-runtime-graph.ts` and the mobile terminal/native-chat adapters.

Preserve host authority, observed-run transfer, retained rows, and folder-workspace behavior. A
renderer-only foreground hint is not a proof and cannot mark a pane covered.

### Tranche 4 — main/runtime local and daemon-backed consumers

After renderer results are stable, migrate the main-side owner/status consumers and local runtime
summary paths (rows 34, 59, and 62), including:

- `src/main/agent-hooks/server.ts` and `src/main/agent-hooks/server/server-status-update.ts`;
- `src/main/runtime/runtime-mobile-agent-status-builder.ts`,
  `src/main/runtime/runtime-mobile-session-projection.ts`,
  `src/main/runtime/orca-runtime-build-pty-terminal-summary.ts`, and the runtime owner helpers;
- `src/main/runtime/orchestration/groups.ts` and its mailbox/action consumers.

The execution host is authoritative for process evidence. Exercise native macOS/Linux, native
Windows, daemon-backed panes, and folder workspaces (not just git worktrees) before advancing.

### Tranche 5 — published host-to-client identity (last)

Only after all local display/action consumers use the canonical resolver, migrate
`src/shared/published-pane-agent-identity.ts` and its callers in
`src/main/runtime/orca-runtime-write-orchestration-pointer-pty.ts` and the terminal-summary builders.
The existing `agentIdentity` value remains backward-compatible. Add an optional, capability-negotiated
`agentIdentityEvidence` sidecar carrying source/coverage, authority/incarnation when known, and
freshness for process proof; old clients ignore it, and new clients treat its absence as unknown
rather than covered proof. Do not add a stream opcode. A title-only WSL route is explicitly marked
uncovered/title-only and is never relabeled as a live process proof.

Run the remote wire compatibility tests against old/new client-host combinations, then run the full
65-row inventory ratchet one final time.

## Host-proof ordering and platform experiments

Do not tune the ladder against a rung that cannot fire. Land the host-stamped WSL foreground
evidence work (the near-complete sibling change) and the SSH equivalent before enabling process
proof in Tranche 1 or publishing it in Tranche 5. Until then, a bare renderer/main process name is
an uncovered hint and cannot outrank launch.

Correctness is measured without user telemetry. For every platform with process evidence, capture
the host's independently selected foreground process (including its opaque PID/start incarnation)
and compare it with the canonical result in deterministic fixtures and an end-to-end pane run:

- macOS and Linux POSIX: direct agent, shell wrapper, nested OMP/Pi, and ambiguous descendant trees;
  assert the ambiguity fence returns unknown and never chooses by depth.
- Windows native: executable paths and `.cmd`/`.bat` launchers through the Windows process table;
  assert shell/wrapper names do not masquerade as the agent.
- WSL: Windows-side `wsl.exe` plus guest inventory anchored to the distro/shell marker; verify a
  guest agent proof is host-stamped and that missing/ambiguous anchors produce `unverifiable`.
- SSH: relay-stamped authority generation/epoch, reconnect, and transport-loss cases; loss of
  contact is `unverifiable`, never evidence that the process exited.
- Daemon-backed and folder workspaces: repeat each applicable fixture through the daemon without
  relying on git metadata.

The fixture runner writes counts and mismatches with `writeFileSync` because Vitest intercepts
`console.log`. Run it with `npx vitest run --config config/vitest.config.ts <target>`; a bare Vitest
command is not valid for this repository. Typecheck after clearing stale incremental artifacts (an
incremental `pnpm tc` can otherwise report a false green), and keep all scratch artifacts outside the
worktree.

## Deletions and non-goals

Delete all comparison-only machinery and tests once canonical calls are live:

- `src/shared/pane-agent-identity-comparison.ts` (the comparison recorder and counters);
- `src/renderer/src/lib/tab-agent-identity-comparison.ts` and its test;
- `src/shared/published-pane-agent-identity-comparison.ts` and its test/wiring in runtime summary
  publication;
- any comparison-only imports, effects, console output, or inventory rows.

Keep `src/shared/pane-agent-identity-adapter.ts`, the canonical resolver tests, the title corpus
characterization, and both inventory ratchets. Do not add telemetry, a shadow decision, launch
flags, command shims, or a required user workflow change.

## Single-ranking risk and mitigation

One ranking can be wrong everywhere at once: a bad source order would affect icons, routing,
status, summaries, mobile, and remote clients simultaneously. Mitigate that systemic risk by:

1. making the 17,496-shape harness and the 648 decision table hard gates, including the freshness
   field trap and equal-rank ambiguity assertions;
2. validating host process truth independently per platform before enabling its rung;
3. migrating in blast-radius order while preserving thin adapters and an uncovered compatibility
   lane, so one tranche can be reverted without rewriting 65 consumers;
4. requiring action floors and run-key supersession so a wrong display hint cannot authorize a write;
5. keeping the process selector's ambiguity fence and the separate OMP/ChatGPT.app selection fix
   explicit, rather than hiding a selector defect inside ladder ordering; and
6. making the optional wire sidecar additive and capability-negotiated, with old-client behavior
   unchanged.

Success is one policy implementation, honest unknowns on ambiguous/unverifiable evidence, identical
answers at all six seams, a passing inventory ratchet after every tranche, and no telemetry or
comparison recorder left in the tree.
