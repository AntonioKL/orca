# Structured native-chat readiness report

Integration branch: `brennanb2025/structured-chat-integration-latest`
Implementation/test head (code): `be52c0d6dcd9478f0303335de5eda5224039e82b`

## Architecture decision

One renderer routing decision selects structured chat only when the execution host and provider
capability are proven. The runtime owns provider adapters, journals, leases, process identity, and
paired-host lifecycle RPCs. SSH remains a distinct terminal-bridge boundary; remote clients never
start providers locally. When the structured toggle/default Chat UI is off, or support is missing,
the recoverable legacy terminal path is retained.

## Verification at this implementation head

- Structured suites: **171 files, 2,655 passed, 3 skipped**.
- Additional launch/settings/runtime suites: **5 files, 1,265 passed, 1 skipped**.
- `pnpm tc:node`: passed.
- `pnpm tc:web`: passed.
- `pnpm run check:code-quality:changed`: passed with 0 new findings (code, type-aware, React Doctor).
- `git diff --check`: passed; worktree clean.

## Platform evidence and limits

- **Native macOS/Linux:** provider lifecycle, journal, prompts, options, images, resume, close,
  and unexpected-exit recovery are covered by passing suites. Linux packaging and the 18-binary
  glibc 2.31 floor scan pass, but packaged Electron startup emitted `Missing X server or $DISPLAY`
  and then segfaulted under the available Xvfb setup; Docker validation was blocked by socket
  permissions. Packaged provider-process smoke remains unproven.
- **Windows:** exact pushed head was checked out on the Windows high-spec paired runtime. The
  process-table suite (25 tests), runtime suite (1,221 tests), Claude suite (41 files, 344 passed,
  11 skipped), and structured RPC/router suites (38 tests) passed. Claude native structured launch
  remains intentionally unsupported on native Windows and is covered by the truthful capability
  fallback; `Claude Code 2.1.251` and `codex-cli 0.151.0` were present. Packaging, path-length,
  and a live authenticated provider turn remain unverified.
- **WSL:** absolute executable resolution, distro-aware routing, WSL git probes, and location
  tests pass. The Windows runtime listed `Ubuntu-24.04` and `Sta4593-Federated`; both VHDX mounts
  failed with `ERROR_SHARING_VIOLATION` even after `wsl.exe --shutdown`, so provider-in-WSL
  execution remains unverified pending elevated lock-owner diagnostics or an approved service
  restart.
- **SSH/Linux:** exact pushed head ran on `neil-ubuntu` (Linux 7.0.0-28, x86_64): 12 focused files
  and 107 tests passed, preserving `live` / `unverifiable` / `exited`. Authenticated Claude
  2.1.233 returned `SSH_LIVE_OK`; a host-owned provider returned `SSH_PROVIDER_LIVE_OK` and
  survived a forced SSH client drop, with host-side PID evidence proving later completion/exit.
  Electron-mediated direct-SSH UI/RPC proof remains unverified.
- **Paired remote Orca:** deterministic structured, paired-runtime, and cross-version suites pass
  (17/89, 12/71, and 16/125). A disposable-auth local Codex 0.151.0 turn returned
  `LIVE_PROVIDER_OK`, but no paired runtime credentials or Electron skill were available; live
  mixed-version publication/reconnect, rendered UI, and paired provider-turn evidence remain
  unverified.
- **Electron:** exact-head Playwright CDP proof passed from the integration worktree. The app
  identity reported `structured-chat-integration-final` on this branch; Experimental settings
  visibly exposed the Chat UI and structured-chat controls, the host-aware scope copy rendered,
  and enabling the toggle set `experimentalStructuredNativeChat: true` with Chat UI as default.
  Console errors: 0 (two pre-existing development warnings). No computer-use or OS-level
  automation was used.

## Recommendation

Internal checks and Electron UI proof are green at this exact head. Windows, WSL, SSH, paired
remote, and packaged Linux evidence gates remain open; keep those units at **land after
fixes/evidence** and do not describe them as live-supported until the required host runs complete.
