# Lane 2 — Setup failed, but the sequenced agent startup waited forever

Branch: `brennanb2025/setup-agent-seq-hang` (off `origin/main` @ fecdf0bde8)
Worktree: `/Users/brennanbenson/orca/workspaces/orca/setup-agent-seq-hang`

## Root cause

The agent gate's only evidence that setup happened is a marker file written by the gated setup
command, and nothing guaranteed that command ever ran: in
`src/shared/setup-agent-sequencing.ts`, `buildPosixSetupCommand` inlined the runner path three
times plus the nonce into one typed line — **1033 bytes for the worktree in the recording, past the
1024-byte canonical input cap a PTY applies before the shell's line editor takes over** — so the
marker was never written and `buildPosixStartupScript` sat silent for the full
`DEFAULT_WAIT_TIMEOUT_SECONDS = 2 * 60 * 60`.

That is one instance of a structural defect with three faces, all fixed here:

| Face | Where | Effect |
|---|---|---|
| Gated command too long to submit | `buildPosixSetupCommand` | marker never written |
| Bare runner launched instead of the gated command | `launch-worktree-background-terminals.ts` `buildSetupCommand` ignored `setup.command` outright | marker never written |
| Setup never launched at all | spawn failures swallowed in `provisionManagedWorktreeTerminals`; the non-awaited branch sets `didSpawnSetup = true` optimistically | marker never written, and the client is told not to retry |

In every case the waiter had no second source of truth and no way to say so.

### On the coordinator's lead

The lead named `activationSetup` in `src/main/ipc/worktree-remote.ts` only carrying
`command: wrappedSetupCommandStr` when **both** `startupTerminalHandle` and
`wrappedSetupCommandStr` are set. **Refuted as the trigger**, but it was a real smell: at that
point `startupTerminalHandle` is always non-null (the only path that leaves it null returns early
with no `activationSetup`), so the conjunct was dead weight hiding the real seam — that the gated
command and the state it depends on were two separable values threaded by hand through four
launchers. It is gone now.

### Evidence for the length finding

- The runner for the recorded worktree still exists on disk:
  `/Users/brennanbenson/orca/orca/.git/worktrees/fix-agent-hooks-post-posix-payloads-as-json/orca/setup-runner.sh`,
  written `Aug 27 07:04` — matching the 7:04 phone clock in `t009.png`. **No `.done` marker
  sibling was ever written**, and the pre-fix gate deletes the marker only when it consumes it,
  which it demonstrably never did.
- Feeding that exact path through the unfixed `createSequencedSetupAgentCommands` yields a
  **1033-byte** `setupCommand`. `TTYHOG` on Darwin/BSD is 1024.
- Frame `e045.png` (t≈45s, re-extracted with output seeking) shows the origin: the mobile
  **Create worktree** sheet, Project `orca`, Run on **Local Mac**, from issue #11292, Agent
  **Claude** — a host-side create, exactly as the brief assumed.

Honest limit: I proved the marker was never written and that the command exceeds the cap for this
worktree. I could not replay which of the three faces fired in the recording — the host does not
retain the PTY command line, and the terminal-history entries for those two PTYs had already
rotated. The fix closes all three regardless, which is what the brief asked for.

## The fix

### (a) An outcome is recorded on every path — structurally

1. **The gated setup command is now short and unsubmittable-proof.** The long script moved into
   `ORCA_SEQUENCED_SETUP_SCRIPT`, the same env-var indirection the startup gate already used (its
   own comment cites this hazard). The command is ~235 bytes and, critically, carries an inline
   fallback: if the env var is missing it runs the bare runner rather than nothing.
2. **The status is written from a shell `trap ... EXIT`** (POSIX) / `try…finally` (Windows), so a
   runner that exits non-zero, aborts under `set -e`, cannot be executed at all (127), or is torn
   down with its pane still records an outcome. Previously only a clean fall-through did.
3. **A `.started` sentinel is written before the script body runs.** Its *absence* is how the
   never-started case gets recorded — from the waiter, which runs on the execution host, rather
   than from a main process that may not share a filesystem with it. This is what makes the
   guarantee structural rather than one more patched branch.
4. **The gated command and its env can no longer be separated.** `applySequencedSetupLaunch()`
   folds both into the `WorktreeSetupLaunch` record every launcher already consumes, and the
   separate `wrappedSetupCommandStr` parameter threaded through four call sites is deleted. A
   launcher cannot now pick up `command` while dropping the half that records the outcome.
5. `launch-worktree-background-terminals.ts` honours `setup.command` instead of always rebuilding
   the bare runner.

### (b) The bound, and why this number

`DEFAULT_WAIT_TIMEOUT_SECONDS` **2 h → 30 min**, plus `SETUP_START_GRACE_SECONDS = 45` and a
progress line every `WAIT_PROGRESS_INTERVAL_SECONDS = 15`.

- **30 minutes.** The slowest legitimate setup we ship against is a cold monorepo install plus a
  native rebuild — single-digit minutes even on a slow link (this repo's own `pnpm install` +
  `rebuild-native-deps` failed at 10.2 s in the recording). 30 min is several times that headroom,
  so it will not cut off a genuinely slow install, while still surfacing inside one sitting rather
  than half a workday. The bound is now a backstop, not the primary signal.
- **15 s progress ticks** are the actual fix for "indistinguishable from a hang" — the terminal is
  never silent again, which is why the bound can stay generous.
- **45 s start grace.** The setup terminal is spawned in the same host operation as the agent
  terminal and writes its sentinel before running a line of script, so 45 s is far beyond a slow
  shell profile plus an SSH round trip. Expiring does **not** fail the launch: it starts the agent
  unsequenced and says why, so a false positive costs a warning line, never a dead terminal.

### (c) The user is told in the agent terminal

Three messages, all on the terminal the user is already looking at:

- setup failed → `Setup failed; skipping agent startup. Setup exited with status 9; open the Setup
  tab for its output, then start the agent yourself once it is fixed.`
- setup never reported starting → `Setup never reported starting within 45s, so this terminal
  cannot tell whether it ran. Starting the agent without waiting for setup.`
- bound reached → `Timed out waiting for setup before starting agent. Waited 1800s without a
  result; the agent was not started. Open the Setup tab for its output.`

Wording is deliberate on the second: not being able to see setup is not evidence that it died, so
it says the terminal cannot tell, and proceeds. That trades the #6298 ordering guarantee for a
live terminal — the pre-#6298 behaviour — only in the case where the guarantee was already void.

## Regression tests — failing against the unfixed code

`src/shared/setup-agent-sequencing.prefix-proof.test.ts` (scratch, not committed) expressed the
required scenarios in HEAD's API and ran against the **unfixed** `setup-agent-sequencing.ts`.
**7 of 7 failed.**

```
 ❯ src/shared/setup-agent-sequencing.prefix-proof.test.ts (7 tests | 7 failed)
   × setup submission stays under the canonical input floor 3ms
   × setup exits non-zero: the gate names the status in the agent terminal 1398ms
   × setup killed mid-run still records an outcome 5005ms
   × setup never started: the agent still launches instead of waiting out the bound 4116ms
   × wrapped command absent: the bare runner launch still records an outcome 5002ms
   × the wait reports progress instead of sitting silent 5002ms
   × the default bound is not a two-hour silent wait 1ms

AssertionError: expected 1033 to be less than 1024
 ❯ src/shared/setup-agent-sequencing.prefix-proof.test.ts:28:40

AssertionError: expected 'Waiting for setup to finish before st…' to contain 'Setup exited with status 7'
- Setup exited with status 7
+ Waiting for setup to finish before starting agent...
+ Setup failed; skipping agent startup.

AssertionError: expected 124 to be +0 // Object.is equality   (setup never started)
- 0
+ 124

AssertionError: expected 'deadline=$((SECONDS + 7200)); echo "W…' to contain 'deadline=$((SECONDS + 1800))'

Error: Test timed out in 5000ms.   (killed mid-run / wrapped command absent / progress)
```

Note `expected 1033 to be less than 1024` — the incident measurement, from the recorded worktree's
own runner path. The three "test timed out" entries are the unfixed code literally hanging.

The committed equivalents live in `src/shared/setup-agent-sequencing.test.ts` under
`describe('setup outcome recording')` and spawn real `bash`:

- `records a non-zero setup status so the agent gate reports the failure` — **setup exits non-zero**
- `records an outcome when the setup runner cannot be executed at all` — **setup exits non-zero (127)**
- `records an outcome when the setup pane is torn down mid-run` — signals the pane's process group;
  asserts the marker reads `killed-setup:143`
- `starts the agent unsequenced when setup is never started at all` — **setup never started**
- `still records an outcome when the setup script env never reaches the setup terminal` —
  **wrapped command absent**: the setup PTY is spawned without `setupEnv`, the fallback still runs
  setup, and the gate still resolves
- `reports progress instead of waiting silently`
- `keeps the POSIX setup submission below the canonical input floor`
- `pairs the gated setup command with the env that carries its script`
- `bounds the default wait well under the two-hour silent timeout it replaced`

## Electron QA — rendered, on my own instance

Own dev instance: CDP `9336`, renderer `5180`, `ORCA_DEV_USER_DATA_PATH=/tmp/orca-lane2-profile.*`,
`ORCA_DEV_INSTANCE_KEY=lane2-setup-seq`. `HOME` untouched. Identity verified **before** any
capture: `devRepoRoot: /Users/brennanbenson/orca/workspaces/orca/setup-agent-seq-hang`,
`devBranch: brennanb2025/setup-agent-seq-hang`. Playwright CDP only — no computer-use, no OS
automation. Torn down by pgid `74450` after confirming its argv pointed at this worktree; the
user's `:5173` dev server was still listening afterward.

Scenario: fixture repo with an `orca.yaml` setup hook that exits 9, repo policy set to
`wait-for-setup` through the real store action, workspace created through `createWorktree` with an
agent startup.

Screenshots in `~/orca-qa/mobile-video-triage-2026-08-27/lane2-setup-hang/`:

- `fix-agent-terminal-reports-failure.png` — the agent terminal, same shape as the recording
  (`bash -lc 'eval "$ORCA_SEQUENCED_STARTUP_SCRIPT"'` → `Waiting for setup to finish before
  starting agent...`), now followed within seconds by `Setup started; waiting for it to finish.`
  and `Setup failed; skipping agent startup. Setup exited with status 9; open the Setup tab…`
- `fix-setup-tab-runs-gated-command.png` — the Setup tab running the new short gated command with
  its `ORCA_SEQUENCED_SETUP_SCRIPT` branch, then the fixture's failure output
- `fix-success-path-agent-starts.png` — setup flipped to exit 0: `Setup started; waiting for it to
  finish.` → `AGENT_ACTUALLY_STARTED`. The #6298 ordering guarantee is intact.

**Not verified in the rendered app:** the never-started and torn-down-mid-run arms (covered by the
shell-level tests only — forcing them through the UI is racy), and every Windows path. The Windows
gate changes mirror the POSIX ones and are covered by unit assertions on the generated PowerShell,
but no Windows machine ran them.

## Scope constraints

- **SSH / remote.** The outcome is recorded by, and read by, shell running on the execution host —
  no main-process filesystem write is introduced, so nothing assumes the client shares a disk with
  the worktree. The never-started message says the terminal cannot tell whether setup ran; it never
  claims setup died. No `live`/`unverifiable`/`exited` verdict is emitted or changed.
- **Remote wire.** No new field and no new stream opcode. `command` and `envVars` are existing
  `WorktreeSetupLaunch` fields that already cross the boundary; the change is additive keys inside
  the existing `envVars` map. New host + old client: the client forwards `envVars` verbatim, so the
  gate works. Old host + new client: the client receives a long unwrapped command as before, and
  the new start-grace and 30-minute bound now protect it instead of a two-hour silence.
- **Windows.** The runner file's `.cmd`-vs-`#!` selection is untouched; no `cmd.exe /c` is
  introduced; the Windows gate stays on `-EncodedCommand` (a single base64 token, not subject to
  the POSIX cap) and gained only the sentinel and the `try…finally` status write. No direct
  `child_process` use added.
- **Folder workspaces.** No new assumption that a workspace is a git worktree; the runner path
  still comes from the existing `createSetupRunnerScript` resolution.
- `src/shared/setup-agent-sequencing.ts` crossed the 300-line `max-lines` limit, so it was **split**
  into `-env`, `-posix-gate`, and `-windows-gate` modules. No `max-lines` disable was added.

## Gates

| Gate | Result |
|---|---|
| `pnpm tc` | clean |
| Affected vitest (12 files) | **1371 passed, 10 skipped, 0 failed** |
| oxlint — code quality | clean |
| oxlint — type-aware code quality | clean |
| oxlint — React Doctor | clean |

`pnpm run check:code-quality:changed` **crashes on Node 26** before linting anything — the pnpm
engine warning lands in the stream it `JSON.parse`s, unrelated to this change. The three
`OXLINT_SCANS` from that script were run directly against the changed files instead (results
above); oxlint confirmed live at 167 rules, and it did catch the `max-lines` violation, which was
fixed by splitting rather than suppressing.

One process note: `pnpm format <path>` reflowed 51 unrelated files across the repo despite the path
argument. Those were reverted; the change set is 9 files.

## Files changed

```
src/shared/setup-agent-sequencing.ts                        (split; gate now records + reports)
src/shared/setup-agent-sequencing-env.ts                    (new)
src/shared/setup-agent-sequencing-posix-gate.ts             (new)
src/shared/setup-agent-sequencing-windows-gate.ts           (new)
src/shared/setup-agent-sequencing.test.ts                   (regression tests)
src/main/ipc/worktree-remote.ts
src/main/runtime/orca-runtime.ts
src/main/ipc/worktrees-local-create-flow.test.ts
src/main/runtime/orca-runtime.test.ts
src/renderer/src/lib/launch-worktree-background-terminals.ts
src/renderer/src/lib/worktree-initial-terminal-seeding.ts
src/renderer/src/lib/worktree-default-terminal-tabs.ts
src/renderer/src/lib/worktree-setup-issue-command-queue.ts
src/renderer/src/lib/worktree-activation-setup-script.test.ts
src/renderer/src/lib/worktree-activation-web-runtime.test.ts
```
