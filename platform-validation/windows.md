# Windows structured-chat validation

- Branch/head: `brennanb2025/structured-chat-integration-latest` / `be52c0d6dcd9478f0303335de5eda5224039e82b`
- Host: Orca paired **Windows high spec**, `win32`, Node `24.18.0`, x64.
- Checkout: `C:/Users/neil/orca/workspaces/orca/structured-chat-windows-exact`.

## Commands and results

- `pnpm test src/main/windows/windows-process-table.test.ts src/main/wsl/wsl-executable-path.test.ts src/main/runtime/orca-runtime.test.ts`: passed; 25 process-table tests and 1,221 runtime tests.
- `pnpm test src/main/claude`: passed; 41 files, 344 passed, 11 skipped.
- Structured RPC/router/runtime suites: passed; 38 tests.
- Provider discovery: Claude Code `2.1.251`; Codex CLI `0.151.0`.

The process-table capability gate and native process addon were exercised on Windows. Native
Claude structured launch is intentionally refused on `win32`; the caller receives the truthful
unsupported result and retains the terminal fallback. A live authenticated provider turn,
packaging, and path-length run were not performed.

## WSL limitation

`wsl.exe -l -q` listed `Ubuntu-24.04` and `Sta4593-Federated`. Starting `Ubuntu-24.04` failed
with `Wsl/Service/CreateInstance/MountDisk/HCS/ERROR_SHARING_VIOLATION` because its VHDX was in
use, so provider execution inside WSL remains unverified.
