# Structured native-chat readiness report

Integration branch: `brennanb2025/structured-chat-integration-latest`
Integration head: `b28c430fd5b1bc25d4a2149d267a4f11a14bb5ad`
Base recorded: `origin/main` = `02a7742406a5a84fb372d6255d5a4367421990bd`

## Exact implementation heads

| Unit | Branch / head | Recommendation |
| --- | --- | --- |
| Claude/provider | `brennanb2025/claude-structured-current` / `ce8e5b5ab6ca0102375ff0765d4a1e3ce8d6ab88` | land after UI proof and independent PR review |
| Windows | `OrcaWin/windows-structured-current` / `f8e351ebaeb2bfd7ec93893ea75f30226572fa97` | land after path-length CI and real-host validation |
| WSL | `brennanb2025/wsl-structured-local` / `a690b67aaa` | land after selected-distro validation |
| SSH/Linux | `brennanb2025/ssh-structured-current` / `e4aa13d4cc` | land after real SSH/OpenClaw validation |
| Paired remote | `brennanb2025/remote-structured-current` / `736e01d8d7` | land after paired-host and cross-version evidence |
| Linux packaging | `brennanb2025/linux-packaging-structured-split` / `b96801e9aa` | do not land as-is; ancestry is broad and needs a focused re-cut |
| Combined integration | `brennanb2025/structured-chat-integration-latest` / `3db8e822e4` | land after the platform evidence gates below |

## Verification completed

- `pnpm test` main/Claude/Codex/WSL/SSH suites: **49 files, 414 passed, 2 skipped**.
- Renderer routing suites: **3 files, 24 passed**.
- `pnpm tc:node`: passed.
- `pnpm tc:web`: passed.
- Changed-file `oxlint` (including React doctor config): passed.
- Cross-version wire suites (agent-session, browser placement, terminal, field shape, lossy snapshot): **5 files, 36 passed**.
- `git diff --check` on the combined head: passed.
- `ref-oss` synchronization completed before implementation/review.
- Architecture split recorded in `docs/architecture/structured-native-chat-platform-split.md`.

## Platform evidence

- **Windows:** worker ran on Windows high-spec Orca host; focused tests and lint passed. Full validation is blocked by node-gyp/MSB3491 path-length failure (>260 characters), so no packaged Windows proof is claimed.
- **WSL:** selected-distro argv/path/WSLENV and ownership tests pass. The Windows remote runtime could not complete a worker attach (timeout, then disk-full on alternate runtime); actual distro/provider and Electron proof remain unverified.
- **Native Linux:** packaging contracts and bounded smoke coverage exist in the prior branch, but the worker branch mixed provider/WSL/Codex changes and is excluded from integration. Ubuntu 20.04/arm64 packaged execution was not run here.
- **SSH/Linux:** verdict tests pass and preserve exactly `live`, `unverifiable`, `exited`. OpenClaw was unreachable during validation; no real disconnect/reconnect run is claimed.
- **Paired remote Orca:** host-aware routing, capability projection, and unsubscribe cleanup tests pass. No paired-host Electron run was available; cross-version harness is covered by existing unit tests but requires release-runner confirmation.
- **Electron UI:** the Claude worker attempted macOS Electron/CDP, but the endpoint became unresponsive. Visible UI proof is therefore unverified; no computer-use or OS-level automation was used.

## Readiness/review outcome

The implementation and platform workers each ran their requested readiness/review scans. The coordinator reran focused tests, typechecks, and changed-code lint on the combined head. No proven in-scope correctness issue remains in those checks. Remaining evidence blockers are infrastructure/topology gates, not silently passed support claims; until they are run, recommendations remain “land after fixes” for affected units.

Legacy behavior is preserved when the structured toggle is off, SSH transport loss remains inconclusive, unknown prompt outcomes are not resent, and remote execution never starts a local provider.
