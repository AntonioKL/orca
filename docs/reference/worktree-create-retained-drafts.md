# Retained composer drafts

## Status

The user approved creating a real workspace and running checkout hooks and shell
profiles before pressing Create, while retaining canceled drafts. This lifecycle
belongs to the speculative worktree-creation work, separate from the mechanical
optimizations. The quick composer's blank-terminal path now starts an ordinary
persisted workspace, requests background shell startup, and adopts the same result
on Create. Cancellation retains it in the normal workspace catalog.

Automatic preparation currently requires the direct desktop API and the
`worktree.background-startup.v1` capability. Runtime-environment and paired-web
clients use ordinary Create until equivalent ownership/adoption is implemented.
Native local agent drafts now prepare their shell when the daemon supports
owner-fenced deferred startup. The original agent command is held until Create;
unsupported providers retain checkout-only preparation. Folder targets, VM recipes,
unresolved PR/issue sources and missing hook approval are not automatically prepared
yet. These remain implementation work, not exclusions from the near-instant objective.

The optional `startup.activate: false` field leaves selection unchanged. Older
callers omit it and retain ordinary activation. Preparing clients must verify the
capability before sending it: an old host can ignore unknown optional fields.
One automatic creation is allowed per composer; explicit Create more begins a new
cycle. Edits after creation retain the old workspace and use ordinary Create when
the final request or execution identity differs.

## Ownership contract

- Reserve the final branch, path, workspace instance and terminal identity for one
  exact composer revision through existing creation and terminal infrastructure.
- Complete checkout, checkout hooks, and included/shared-file handling at the final
  path before starting shell profiles. Setup and agent commands follow their run
  policy; reservation must not implicitly launch an agent.
- Once profiles start, retain the workspace on cancel, edit, expiry or failure.
  Surface it as a normal workspace available for later use or explicit removal.
  Never return it to the disposable preparation pool or hard-reset it for reuse.
- Limit automatic reservation to one composer revision. Edits must not generate an
  unbounded series of workspaces or change a running shell's branch, cwd or
  environment to impersonate a different request.
- Adoption must match composer revision, execution host, repository, workspace root,
  branch/base, shell and environment. Changed bases must not cause a destructive
  reset of shell-generated work. Quick submit must join existing creation instead
  of starting a duplicate.
- Preserve the same PTY and buffered output on adoption. Setup and agent commands
  must run at most once according to the selected policy.
- The execution host owns all execution. Lost contact is unverifiable. Older peers
  need an ordinary-create fallback; any reservation capability must be negotiated.
  Folder, WSL and SSH eligibility must be explicit.

## Why a prepared checkout cannot own this shell

The current pool contains detached disposable checkouts that may be moved,
retargeted, hard-reset and removed. Shell profiles can create tracked, untracked
and ignored files, or launch descendants. Even non-force `git worktree remove`
can delete ignored-only output while ordinary status reports a clean checkout.
A real workspace must own the shell before profiles run.

## Evidence and remaining validation

An eight-sample ABBAABBA process experiment, with identical two-second lead time
and the final checkout already present in both arms, measured median simulated
submit-to-input of 764.49 ms for late shells and 12.48 ms for early shells. It
verified final cwd, branch, HEAD and PTY retention. This was not a composer test.

A separate daemon-backed Electron trial adopted an already-created workspace with
the same PID and terminal identity, rendering replay after 116.6 ms and generated
keyboard output after 177 ms. PR A fixes duplicate snapshot/live startup output
found in that experiment. This was workspace selection, not composer submission.

The latest ordinary composer trial still measured prompt readiness at 1591.1 ms.
Do not describe the process or selection measurements as instant composer creation.

Before completing the retained-draft implementation, verify rendered warm and
quick-submit paths, edits/cancellation, ignored and dirty profile output, base
drift, concurrent names, shell failure, host loss, application crash recovery and
single-PTY adoption. Verify that canceled drafts remain discoverable after restart.

## First integrated composer measurements (development build, macOS)

A rendered trial on the copied Orca test repository verified one backend create,
selection unchanged while the composer remained open, then actual terminal input
and output after Create. Clicking as soon as checkout returned showed the prompt
after 1157 ms. Waiting another two seconds for shell startup reduced that to
306.5 ms; typed-command output appeared 349.1 ms after the click (23.4 ms from
Enter to output). Preparation itself took 4.4–5.2 seconds, largely waiting for the
existing prepared checkout. These are single samples, not a performance guarantee.

A generated-name canceled draft remained visible in the rendered sidebar after
renderer reload. Application-process crash/restart, dirty/ignored profile output,
and all remote topology cases still need verification.

## Deferred agent-shell composer measurements (development build, macOS)

The native local composer now prepares the original agent shell/environment and
holds its command in the daemon until Create. Release requires the same workspace,
PTY incarnation and operation; retry cannot create a replacement or type a fallback
command into an uncertain terminal. Manual use retires the held command.
Preparation does not publish agent-start telemetry or mark Claude as running.
Daemon reattachment includes optional deferred-startup state, so a new main process
can distinguish an unreleased shell from an agent. Telemetry acknowledgement state
is not durable across main-process crashes. Claude release rechecks account switches.
New preparation requires daemon v38, which reports that state. Release remains
compatible with v37 so an upgrade does not strand commands already held there.

Two real Codex trials each created one workspace. With 2.62 seconds between opening
and Create, selection took 156.9 ms and the prompt with a resolved model appeared
after 582.1 ms. Clicking after 333.7 ms took 497.3 ms to selection and 1498.6 ms to
the prompt/model. MCP servers were still initializing. The isolated test settings
disabled Codex's update check; product defaults are unchanged. These single samples
do not establish consistent near-instant agent or tool readiness.

A canceled draft was found through workspace search and opened as a working shell.
Running a harmless printf command rendered its output; a subsequent release of the
original held command returned `retired`. No second workspace or agent was started.
A separate v38 draft survived a normal app-process restart: workspace search opened
the original terminal handle, its shell prompt and subsequent printf output rendered,
and release using the original incarnation and operation returned `retired` after
manual use. This does not prove forced-crash or remote-host recovery.
Final readiness, crash/restart, supported-topology and adverse-path validation are
still outstanding before publishing the combined ad hoc release.
