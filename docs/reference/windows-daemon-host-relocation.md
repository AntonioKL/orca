# Windows daemon-host relocation

On Windows the terminal daemon does not run from the install directory. Before it forks the
daemon, Orca materializes a trimmed copy of its own runtime under
`%LOCALAPPDATA%\Orca\daemon-host\<app version>\` and forks the daemon from there
(`src/main/daemon/daemon-host-relocation.ts`). This is what keeps live terminals alive across an
auto-update and across a crash of the main process.

Read this before changing the copy plan, the host exe name, the LOCALAPPDATA layout, or
`config/nsis/daemon-host-uninstall.nsh`.

## What the relocation actually escapes

The killer is **electron-builder's process sweep, matched on image path** — not file deletion.
Windows will not delete a running image, so `RMDir /r "$INSTDIR"` cannot end the daemon on its own.

In app-builder-lib's `allowOnlyOneInstallerInstance.nsh`, `FIND_PROCESS` / `KILL_PROCESS` have two
branches:

| Branch   | Condition                                                                     | Selector                                                                 |
| -------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Primary  | `powershell.exe` runs and process-scope `ExecutionPolicy` is not `Restricted` | `Win32_Process` where `$_.Path.StartsWith('$INSTDIR')` — **path-scoped** |
| Fallback | PowerShell missing or blocked (WDAC/AppLocker, Server Core)                   | `taskkill /IM "<AppName>.exe"` — **image-name-scoped**                   |

So on essentially every machine the sweep is path-scoped, and a daemon whose image lives under
`%LOCALAPPDATA%` is out of range regardless of what the file is called. **Survival is a property of
the path.** The name only matters on the fallback branch.

## Why the exe is copied verbatim (and not renamed)

The host exe keeps the app exe's own file name (`daemonHostExeName()` returns
`basename(process.execPath)`), so the relocated image is a byte-for-byte copy of a signed binary
under its original name. A byte-identical copy of a signed PE retains its Authenticode signature.

An earlier revision copied it as `orca-terminal-daemon.exe` specifically so the fallback
`taskkill /IM Orca.exe` could not match. That bought survival on the rare no-PowerShell host and
cost a textbook defence-evasion signature: _a process copies its own image into a user-writable
directory under a different name so a kill-by-image-name cannot match it, then runs detached and
survives the installer._ Microsoft Defender for Endpoint flagged it as MITRE **T1036
(Masquerading)**, and — because it is the process every other flagged action is attributed to — it
acted as a reputation multiplier on unrelated findings. No VS Code fork does this.

Trading the fallback branch for the name is the right trade:

- On the primary branch nothing changes: the daemon still survives the update.
- On the fallback branch the daemon is killed with the app and terminals **cold-restore** on
  relaunch. That is the documented pre-relocation behaviour, a first-class outcome the update
  harness already asserts (`--expect cold-restore`), not a failure.
- Relocation is fail-open end to end anyway: any materialization failure returns `null` and the
  caller forks the install-dir host.

## Options that were rejected

| Option                                                                        | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Materialize the tree from the NSIS installer                                  | The daemon host is ~246 MB. Writing it at install time doubles install footprint and lengthens the window in which the app is down during a silent update. Worse, on a per-machine install (`INSTALL_MODE_PER_ALL_USERS`) the installer runs as the installing admin, so `$LOCALAPPDATA` is the wrong user's — every other user still needs the runtime path, which means the runtime self-copy stays in the product and the signal is only made rarer.                                          |
| Ship a second signed `orca-terminal-daemon.exe` in the installer              | `Orca.exe` is 235,555,328 bytes (224.6 MiB). electron-builder's NSIS uses solid LZMA with a 64 MB dictionary, so a second copy 224 MB downstream does not dedupe; the compressed installer grows by roughly a whole compressed Electron binary, paid by every user on every update download. It also does not remove the runtime copy — the helper still has to reach `%LOCALAPPDATA%` to escape the sweep — so it buys the same signal reduction as the verbatim copy at a large download cost. |
| Override `customCheckAppRunning` to force a path-scoped kill on both branches | It _replaces_ electron-builder's whole detect-and-kill block, including the app-is-running dialog, the retry loop and the elevated-app handling. That is a large rewrite of an update path with no unit-test coverage, only manual-dispatch E2E, for a branch almost nobody is on.                                                                                                                                                                                                               |
| Hardlink instead of copy                                                      | Avoids the 246 MB entirely and is not a "copy" at all, but is NTFS-and-same-volume-only and introduces fresh failure modes (link counts, AV interception, cross-volume installs). Worth revisiting deliberately, not as part of a signal fix.                                                                                                                                                                                                                                                    |

## Invariants to preserve

- The host exe name is **derived from `process.execPath`**, never a literal. A future
  `executableName` or dev-channel rename must follow automatically; pinning a name of our own is
  how the mismatch creeps back.
- The daemon is identified by **PID and command line**, never by image name — in the product
  (`daemon-pid-file-parse`, `daemon-process-inspection`) and in the harness
  (`tests/tools/win-update-e2e/daemon-processes.mjs`). Nothing may start matching on the exe name.
- `config/nsis/daemon-host-uninstall.nsh` kills the daemon by image name. That now also matches the
  app's own exe, which is correct on a genuine uninstall — the product is being removed — but its
  `${isUpdated}` guard must stay: electron-builder runs the uninstaller during every update's
  `uninstallOldVersion`, and killing the daemon there defeats the whole feature. The legacy
  `orca-terminal-daemon.exe` name stays in the macro to reap hosts left by older builds.
- `LOCAL_HOST_ROOT_NAME` in `daemon-host-relocation.ts` and the path in the uninstall macro are the
  same directory. Change both together.

## Verifying a change

Unit coverage lives in `src/main/daemon/daemon-host-relocation.test.ts` (copy plan, verbatim
naming, marker/atomic publish, fail-open, prune veto). Nothing in unit tests can prove survival, so
any change to this file or to the NSIS macro needs the packaged harnesses:

- `.github/workflows/win-update-survival-e2e.yml` — builds an installer from the branch and updates
  it over itself with `--expect survival`. The primary proof.
- `.github/workflows/win-crash-survival-e2e.yml` — proves the daemon survives a main-process crash.
- `.github/workflows/windows-terminal-restart-e2e.yml` — terminal restart behaviour.
- `.github/workflows/win-update-e2e.yml` — release-tag-to-release-tag update, both `survival` and
  `cold-restore` profiles.

All four are `workflow_dispatch`-only (the two update workflows also carry a push trigger pinned to
one historical feature branch), so they must be dispatched by hand against this branch before
merging a change here — which requires the workflow files to already exist on `main`.
