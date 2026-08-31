# Structured native-chat readiness report

Integration branch: `brennanb2025/structured-chat-integration-latest`
Exact integration head: `2dd6d4d2e9cb36d7f82aec72e2688fea2a08b6a7`

## Architecture decision

One renderer routing decision selects structured chat only when the execution host and provider
capability are proven. The runtime owns provider adapters, journals, leases, process identity, and
paired-host lifecycle RPCs. SSH remains a distinct terminal-bridge boundary; remote clients never
start providers locally. When the structured toggle/default Chat UI is off, or support is missing,
the recoverable legacy terminal path is retained.

## Verification at this exact head

- Structured suites: **171 files, 2,655 passed, 3 skipped**.
- Additional launch/settings/runtime suites: **5 files, 1,265 passed, 1 skipped**.
- `pnpm tc:node`: passed.
- `pnpm tc:web`: passed.
- `pnpm run check:code-quality:changed`: passed with 0 new findings (code, type-aware, React Doctor).
- `git diff --check`: passed; worktree clean.

## Platform evidence and limits

- **Native macOS/Linux:** provider lifecycle, journal, prompts, options, images, resume, close,
  and unexpected-exit recovery are covered by passing suites. Packaged provider-process smoke was
  not run here.
- **Windows:** structured capability is advertised only when the process-table addon proves
  creation-time identity; otherwise the renderer stays on terminal chat. Real Windows native and
  fallback execution, packaging, and path-length CI remain unverified.
- **WSL:** absolute executable resolution, distro-aware routing, WSL git probes, and location
  tests pass. A selected-distro provider attach/teardown run was unavailable.
- **SSH/Linux:** verdict vocabulary remains exactly `live`, `unverifiable`, `exited`; transport
  loss never proves death. Real OpenClaw disconnect/reconnect evidence is unavailable.
- **Paired remote Orca:** owning-host target resolution, publication/lifecycle routing, and
  cross-version unit coverage pass. A paired-host Electron run and live mixed-version run were
  unavailable.
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
