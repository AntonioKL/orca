# SSH/Linux structured-chat validation

- Branch/head: `brennanb2025/structured-chat-integration-latest` / `be52c0d6dcd9478f0303335de5eda5224039e82b`
- Host: OpenClaw SSH execution host `neil-ubuntu`, Linux `7.0.0-28-generic`, x86_64.
- Checkout: `/home/brennan/orca-structured-chat-ssh-exact`.

## Commands and results

- Structured adapter/runtime tests: passed; 37 tests.
- SSH verdict, reconnect, and process-liveness suites: passed; 19 tests.
- `command -v claude; claude --version; command -v codex; codex --version`: Claude Code `2.1.233`, Codex CLI `0.151.0`.

The tests preserve the exact SSH verdict vocabulary `live`, `unverifiable`, and `exited`, and
assert that transport loss is not process death. A live authenticated provider turn and a forced
network disconnect/reconnect against a running structured provider were not performed.
