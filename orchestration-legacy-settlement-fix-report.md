# Legacy compatibility settlement fix

## Outcome

Fixed the four failing legacy compatibility/takeover tests without weakening replay or authority fencing.

## Changes

- `settleWorkerReportInTransaction` now transitions `worker_dispatches` only when the reporting Dispatch has a supervised worker row. Context-only/unsupervised Dispatches still settle their Task and Dispatch, matching the supported legacy-adoption and low-level-dispatch contract.
- The A-era replay test now constructs its deliberately pre-boundary storage state with direct fixture SQL. This preserves the current lifecycle rule that a completed Task cannot be reopened through `updateTaskStatus`, while retaining coverage that replay cannot touch a newer current attempt.

No takeover, recipient-routing, principal-attestation, or stale-proof logic changed.

## Validation

- Target files: 2 files, 29 tests passed.
- Legacy/lifecycle related suite: 14 files, 126 tests passed.
- Additional run-list compatibility, runtime-update settlement, and current-authority precedence suite: 3 files, 19 tests passed.
- `pnpm tc:node` passed.
- Targeted `oxlint` passed.
- `git diff --check` passed for the changed source and test files.
