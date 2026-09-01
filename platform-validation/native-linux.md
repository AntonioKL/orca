# Native Linux/package validation

- Validation head: `brennanb2025/structured-chat-integration-latest` /
  `be52c0d6dcd9478f0303335de5eda5224039e82b`.
- Available evidence: Linux structured lifecycle, journal, prompts, options, images, resume,
  close, and unexpected-exit behavior is covered by the passing focused suites and the exact-head
  SSH/Linux run.

## Package evidence

- `pnpm build:linux` produced `dist/orca-linux.AppImage` (~195 MB) and
  `dist/orca-ide_1.4.178-rc.2_amd64.deb` (~155 MB).
- `verify-linux-glibc-floor` passed for all 18 bundled native binaries against the Ubuntu 20.04 /
  glibc 2.31 floor.
- Docker packaged-startup validation was blocked by permission denial on
  `/var/run/docker.sock`.
- Running `dist/linux-unpacked/orca-ide` under the available Xvfb setup exited with
  `Missing X server or $DISPLAY`, followed by a segmentation fault.

Packaged Electron startup and a packaged structured provider turn remain **unproven** in this
environment. Keep native Linux at **land after fixes/evidence**; rerun the bounded startup oracle
on a disposable Linux runner with a valid Xvfb/D-Bus session and preserve logs on failure.
