# Retained composer drafts

## Status

The user approved creating a real workspace and running checkout hooks and shell
profiles before pressing Create, while retaining canceled drafts. This lifecycle
belongs to the speculative worktree-creation PR, separate from the mechanical
optimizations. It is not implemented by the current prefetch and backend-startup
changes.

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
