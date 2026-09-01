# Paired remote Orca validation

- Requested baseline: `brennanb2025/structured-chat-integration-latest`
  (`d84a519a6543354bd96b25616a37fd2252d0de49`).
- Validation child checkout: `brennanb2025/structured-chat-paired-remote`
  (`fa0180dc61a0b1e83ee0aed69555b56a097142aa`).
- No paired host credentials or authenticated remote runtime were available in this session.

## Deterministic evidence

- Structured native-chat availability/session/component suites: **17 files, 89 tests passed**.
- Paired browser host reconnect/reconciliation/runtime/publication/outage/reconnect suites:
  **12 files, 71 tests passed**.
- Cross-version publication, structured-session replay/rollback, runtime-exit, RPC gates/hold,
  protocol compatibility, and outbox suites: **16 files, 125 tests passed**.

These are contract tests covering mixed-version optional-field/fallback behavior, publication
ownership, reconnect/replay fencing, and runtime-unavailable/refusal decisions. No rendered paired
client UI was exercised.

## Local provider attempt and blockers

An authenticated Codex CLI `0.151.0` turn using a disposable auth home and read-only sandbox
returned `LIVE_PROVIDER_OK`; the disposable home was removed. This proves local authentication
only, not execution through a paired runtime.

The Electron skill and paired runtime endpoint/credentials were unavailable, so rendered UI,
live paired publication/reconnect, and a paired authenticated provider turn remain **unverified**.
Keep this topology **land after fixes/evidence**.
