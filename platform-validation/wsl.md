# WSL structured-chat validation

- Branch/head: `brennanb2025/structured-chat-integration-latest` / `be52c0d6dcd9478f0303335de5eda5224039e82b`
- Host boundary: Windows high-spec paired runtime, selected WSL distro owned by `wsl.exe`.

## Evidence

- WSL resolver, distro-aware routing, WSL git environment, and folder/workspace tests pass on the
  exact branch through the Windows test suite.
- `wsl.exe -l -q` reported `Ubuntu-24.04` and `Sta4593-Federated`.
- Attempts to start both distros failed before provider launch with
  `Wsl/Service/CreateInstance/MountDisk/HCS/ERROR_SHARING_VIOLATION`: each distro VHDX was in use.

Because neither selected distro could be attached, this run does not prove provider execution
inside WSL, guest account/config roots, restart, or teardown. WSL remains **land after
fixes/evidence**.
