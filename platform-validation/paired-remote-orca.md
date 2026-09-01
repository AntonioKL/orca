# Paired remote Orca validation

- Branch/head: `brennanb2025/structured-chat-integration-latest` / `be52c0d6dcd9478f0303335de5eda5224039e82b`
- Client: local desktop Orca.
- Runtime: paired **Windows high spec**, runtime id `4b5a97ba-c5cf-4c58-9029-6dff541b788b`, app
  `1.4.193-adhoc.20260830235404`.

The client reported runtime state `ready` and capabilities including `agent-session.structured`,
`agent-session.host-authority`, shared-control, and runtime-environment support. The exact branch
was checked out on the paired host and exercised through the paired terminal. Windows structured
RPC/router/runtime tests passed (38 tests), and no provider process was launched by the local
client during validation.

Live mixed-version publication/reconnect, runtime-unavailable versus transport-connected UI, and
an authenticated provider turn were not performed. Keep this topology **land after fixes/evidence**.
