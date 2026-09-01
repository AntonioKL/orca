# WSL structured-chat validation

- Validation head: `brennanb2025/structured-chat-integration-latest` /
  `be52c0d6dcd9478f0303335de5eda5224039e82b`.
- Validation worktree: `OrcaWin/wsl-phase0-diag` on the Windows high-spec paired runtime
  (`C:/Users/neil/orca/workspaces/orca/wsl-phase0-diag`).
- Host boundary: Windows `10.0.26200.9168`; WSL 2 (commands were issued through a read-only
  Git Bash terminal).

## Discovery and mount diagnostics

`wsl.exe --status` reported Ubuntu-24.04 as the default WSL 2 distribution, and `wsl.exe -l -q`
listed `Ubuntu-24.04` and `Sta4593-Federated`; both were stopped. A no-op guest launch for each
failed before process launch with `Wsl/Service/CreateInstance/MountDisk/HCS/ERROR_SHARING_VIOLATION`
because its VHDX was in use by another process.

Read-only lock checks found `vmcompute`, `wslservice`, and two `vmmemWSL` processes. Sysinternals
`handle.exe` was unavailable; `openfiles /query` and Hyper-V event-log inspection were denied for
the non-administrator session. The only non-destructive remediation attempted was `wsl.exe
--shutdown`; both VHDX mount failures reproduced afterward. No unregister, VHDX modification,
service restart, or deletion was performed.

## Provider execution gate

`wsl.exe -d <distro> --exec claude --version` and `--exec codex --version` failed for both distros
with the same mount error. Structured Claude/Codex execution, guest account/config roots, restart,
and teardown are therefore **unverified**. WSL remains **land after fixes/evidence**; the next
host-side action is an elevated handle-owner check or approved VM/WSL service restart, followed by
rerunning discovery and provider probes.
