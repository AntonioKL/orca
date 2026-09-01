# SSH/Linux structured-chat validation

- Validation head: `brennanb2025/structured-chat-integration-latest` /
  `be52c0d6dcd9478f0303335de5eda5224039e82b`.
- Host: OpenClaw SSH target `openclaw` → `neil-ubuntu`, Linux `7.0.0-28-generic`, x86_64, user
  `brennan`.
- Checkout: `/home/brennan/orca-structured-chat-ssh-exact`.
- Provider CLIs: Claude Code `2.1.233`; Codex CLI `0.151.0`.

## Exact-head tests

The focused structured adapter/runtime and SSH verdict/reconnect/process-liveness suites passed:
**12 test files, 107 tests**. The cases preserve the exact `live` / `unverifiable` / `exited`
vocabulary and do not manufacture process absence from lost transport.

## Live provider and reconnect evidence

- An authenticated one-turn Claude stream returned `SSH_LIVE_OK`.
- A host-owned detached Claude process reached `task_started` and returned
  `SSH_PROVIDER_LIVE_OK` with `is_error=false` and `subtype=success`.
- The local SSH client was deliberately killed after the stream started. A fresh connection then
  observed the provider PID alive via `kill -0`; the host subsequently published successful turn
  completion and later observed the provider exit.

This establishes host-side survival and completion across a forced SSH transport drop. The drop
itself remains `unverifiable` under the SSH execution-boundary rule; `live` and `exited` came only
from host-side evidence.

The Electron-mediated direct-SSH `agentSession.*` RPC/UI surface was not driven end-to-end, so a
rendered direct-SSH interaction remains unverified.
