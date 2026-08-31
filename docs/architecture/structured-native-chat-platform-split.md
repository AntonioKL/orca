# Structured native-chat platform split

## Decision

Use one shared session contract and one routing decision, then keep execution-host adapters in focused changes. The shared contract owns durable records, journal/replay, mutation admission, publication compatibility, tab semantics, and legacy fallback. An adapter may create a structured session only when the execution host proves provider capability; otherwise the caller receives a truthful refusal and uses the existing terminal path.

Every entrypoint (workspace creation, quick command, new-tab launch, restore/resume, and remote activation) calls the same routing seam. The seam evaluates the toggle, Chat default, provider, workspace kind, execution host, and host capability. It never launches a provider on a different host and never retries a prompt whose delivery outcome is unknown.

## PR boundaries

1. **Provider adapters** — Claude stream-json and Codex lifecycle integration, provider-owned roots, identity, prompts, options, images, resume/fork, cancellation, and shutdown. This is reviewable without platform-specific process plumbing.
2. **Windows native** — Windows process identity/start-time proof, `runProcess`/`spawnProcess` launches, CmdOrCtrl behavior, and Windows fallback. WSL remains a separate host.
3. **WSL** — distro selection, guest paths and environment, `buildWslExecArgs`, captured-login-shell parsing, and WSL process fencing. Windows-host launches are never substituted for the distro provider.
4. **Native Linux/package** — provider lifecycle on Linux plus AppImage/native-module architecture contracts and the glibc 2.31 floor.
5. **SSH/Linux** — execution-host-owned provider and journal state, reconnect/restart reconciliation, and `live` / `unverifiable` / `exited` verdicts.
6. **Paired remote Orca** — capability negotiation, agent-session/session-tab publications, relay reconnect, old-client/new-host projection, and no-local-provider guarantees.

Each boundary starts from the latest `origin/main`, has its own child worktree and exact head, and lands only after focused tests, readiness/review scans, and topology-appropriate evidence. The boundaries avoid a second intertwined refactor while preserving a small shared contract and making unsupported hosts recoverable.

## Compatibility and safety

- Toggle off keeps the legacy terminal path byte-for-byte in routing behavior.
- New wire fields are optional; new stream opcodes require capability negotiation.
- Transport loss is not process death; SSH verdicts are exactly `live`, `unverifiable`, or `exited`.
- Folder workspaces and git worktrees use the same host-owned resolution.
- Windows child processes use the shared process wrapper, and WSL commands use the shared argv/captured-shell builders.
- Packaged Linux artifacts are checked against architecture and glibc floors before release.
