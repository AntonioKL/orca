# Missing-verdict regression fix

## Outcome

`inspectWorkerTerminal` now preserves legacy local/folder fallback behavior when the runtime has no liveness verdict: connected terminals are `live` and disconnected terminals are `exited`. An SSH-scoped worker with no authoritative verdict remains `unverifiable` with `missing_liveness_verdict`; explicit `live`, `exited`, and `unverifiable` verdicts still take precedence.

## Coverage

- Added focused regression tests for local live, local exited, and SSH missing-verdict observations.
- Passed 10 affected test files / 90 tests covering worker observation, manual dispatch, worker stop, worker recovery, worker release, and federation liveness.
- Passed `pnpm tc`.
- Passed targeted `oxlint`, `oxfmt`, and `git diff --check` for the changed source and test files.
