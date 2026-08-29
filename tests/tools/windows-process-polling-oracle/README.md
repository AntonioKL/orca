# Windows process polling oracle

This physical-Windows harness injects a preload before the Electron main and relocated terminal
daemon and their worker threads load application modules. It records every successful Node
asynchronous or synchronous child-process spawn call with executable, argv, returned pid, parent pid,
timestamp, and stack. A source audit excludes native `CreateProcess` launchers from these roots. A separate native Toolhelp
watcher independently validates OS-visible starts and enriches command lines; it is not the
authoritative call count because a polling snapshot can miss short-lived children. The harness never
launches PowerShell or WMI itself.

Build the native observer once, then keep the entire oracle byte-identical for all four runs:

```powershell
node config/scripts/build-windows-process-tree-relay-addon.mjs --arch=x64 --out=.build/windows-process-tree/x64
node tests/tools/windows-process-polling-oracle/oracle.test.mjs
node tests/tools/windows-process-polling-oracle/run.mjs --exe C:\build\Orca.exe --output C:\evidence\baseline-open --label v1.4.190 --resource open --duration-ms 90000
```

For an exact source build whose local package cannot render, launch the pinned Electron binary with
`--app-dir` after `pnpm run build:electron-vite`. Reports hash the complete `out/` bundle,
packaged `app.asar` and process-table addon when present, plus the materialized daemon executable,
entry, and addon.

Run `closed` and `open` against v1.4.190, latest `origin/main`, the candidate, and a build with the
candidate reverted. Compare `oracleSha256` before comparing counts. The primary stable-window gate is
zero recurring PowerShell/WMI process-table probes in either Resource Manager state. One-shot startup,
hook lifecycle, port scan, and stale-daemon scenarios are separate phases and must not be folded into
the idle count.
