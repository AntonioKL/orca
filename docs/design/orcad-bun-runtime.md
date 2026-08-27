# Bun-backed orcad

**Status:** design validated by a small macOS/Linux proof; no production cutover.

## Decision

Ship a pinned Bun executable inside each orcad install slot and run both `orcad.js` and the terminal daemon with it. Replace `node-pty` in the daemon with `Bun.Terminal`; do not try to make the current `node-pty` path the Bun contract.

This removes the host Node version and Node ABI from deployment. It also removes the `node-pty` prebuild, libc, compiler, and spawn-helper matrix once the migration window closes.

Use the ordinary Bun executable plus the existing three JavaScript entrypoints, not `bun build --compile`, for the first cutover. orcad needs two independently forked children, versioned daemon adoption, transparent content hashing, and rollback to older JavaScript. A slot-local runtime is easier to inspect and roll back than three compiled executables.

## Measured evidence

| Surface                                                        | macOS arm64                                                                | Real Linux x64 host                                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Existing `orcad.js --orcad-smoke-load-check` under Bun         | Bun 1.3.14: pass; this exits before binding RPC                            | not yet exercised                                                                        |
| Runtime SQLite                                                 | `node:sqlite` is absent; `bun:sqlite` adapter round-trip passes            | not yet exercised                                                                        |
| Runtime WebSocket server                                       | listener binds, but `ws` over Bun's `node:http` never completes an upgrade | not yet exercised                                                                        |
| `@parcel/watcher` loads and reports a real file event          | Bun 1.3.14: pass                                                           | not yet exercised                                                                        |
| `Bun.Terminal` spawn/output/exit                               | Bun 1.3.14: pass                                                           | Bun 1.3.13: pass                                                                         |
| Detached `node:child_process.fork` + IPC child outlives parent | Bun 1.3.14: pass                                                           | not yet exercised                                                                        |
| Current `node-pty` under Bun                                   | native loads, child exits, output is lost; an interactive shell hangs      | native loads and output round-trips                                                      |
| Current Node-backed orcad lifecycle                            | previously proven                                                          | 12/12 on a real Ubuntu host, including same-daemon reattach and scrollback after restart |

The macOS `node-pty` result rules out “run the existing addon under Bun” as a portable strategy. A successful native load is not enough; it can silently lose the terminal stream.

Bun's documented platform contract is suitable for Orca's floor:

- one dependency-free executable;
- Linux x64/arm64 glibc binaries require glibc 2.17, below Orca's glibc 2.31 floor;
- musl binaries exist for Linux x64/arm64;
- macOS x64/arm64 and Windows x64/arm64 artifacts exist;
- `Bun.Terminal` uses `openpty()` on macOS/Linux and ConPTY on Windows as of Bun 1.3.14.

Sources: [Bun installation](https://bun.com/docs/installation), [Bun PTY API](https://bun.com/docs/runtime/child-process#terminal-pty-support), [Bun 1.3.14 Windows ConPTY notes](https://bun.com/blog/bun-v1.3.14#bunterminal-on-windows-via-conpty).

## Full-runtime migration POC

A Node orcad created a real terminal, wrote a nonce, stopped cleanly, and left its daemon alive. The same bundle then started under Bun against the same data root.

Results:

- Bun published readiness and adopted the exact legacy daemon PID.
- `node:sqlite` was absent. A narrow `bun:sqlite` adapter restored synchronous persistence startup.
- The Node `ws` client could not connect to Bun orcad. A bare WebSocket upgrade also timed out: Bun's `node:http` listener bound, but the `ws` server never received/completed the upgrade.
- The terminal remains `live` in the adopted Node daemon, but its state is **unverifiable** through the Bun control plane. It was not proved exited or lost.

Therefore daemon adoption—the no-stranding mechanism—is sound, but full user migration is blocked before PTY backend selection by the runtime WebSocket server. `WebSocketTransport` needs a Bun-native `Bun.serve` implementation (or a proven upstream `node:http`/`ws` fix) behind the existing `RpcTransport` contract.

## Shipping shape

Each content-addressed install remains self-contained:

```text
orcad-<version+hash>/
  bun                         # bun.exe on Windows
  orcad.js
  daemon-entry.js
  parcel-watcher-process-entry.js
  agent-browser-<platform>-<arch>
  .version
  .install-complete
```

Build and deploy rules:

1. Pin one Bun version and release-asset SHA-256 per supported platform/arch. Never download `latest` during build or activation.
2. Include the Bun executable in `ORCAD_ARTIFACTS` and the content hash. Mark it executable before `.install-complete` is written.
3. Launch `<slot>/bun <slot>/orcad.js`; never consult `PATH` for Bun or Node.
4. Fork children with the same slot-local `process.execPath`. Preserve detached/IPC behavior and the daemon's user-data relocation rules.
5. Report optional `runtimeKind`, `runtimeVersion`, and `ptyBackend` health fields. Keep old health fields readable during skew; absence remains unknown.

The launch command should name a runtime executable rather than `nodePath`. Activation records need an optional per-version runtime descriptor. Its absence means the legacy Node launch path, so rollback can still start an older Node slot instead of incorrectly feeding it to Bun.

## PTY backend boundary

The daemon already exposes the right internal seam: `SubprocessHandle`. Add a Bun implementation behind `spawnNativeDaemonPty`; do not let Bun types reach the daemon protocol, RPC, renderer, or SSH layers.

| Required behavior                                         | Bun mapping                                                           | State                            |
| --------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------- |
| spawn with cwd/env/cols/rows                              | `Bun.spawn({ terminal })`                                             | proven                           |
| output                                                    | `terminal.data`, streaming `TextDecoder`                              | proven                           |
| input                                                     | `terminal.write()`                                                    | proven in POC                    |
| resize                                                    | `terminal.resize()`                                                   | proven in POC                    |
| real exit code                                            | `await subprocess.exited`, not terminal `exit`                        | proven                           |
| signal/kill                                               | `subprocess.kill(signal)` plus existing process-tree enforcement      | needs contract tests             |
| foreground process                                        | shell name fallback plus existing PID-anchored process-table resolver | needs agent tests                |
| POSIX slave path                                          | not exposed by Bun                                                    | needs shell-ready fallback proof |
| pause/resume producer                                     | no Bun API                                                            | release blocker                  |
| Windows per-PTY job membership and exact tree termination | not exposed by Bun                                                    | release blocker                  |
| ConPTY clear/wrap behavior                                | differs from patched `node-pty`                                       | release blocker                  |

### Why pause/resume blocks a default switch

`Bun.Terminal` has `write`, `resize`, `ref`, `unref`, and `close`, but no read-side `pause`/`resume`. Orca negotiates output pause on the terminal stream and currently calls `node-pty.pause()` so a flooding child eventually blocks on the kernel PTY buffer.

Dropping output, buffering without a hard bound, or mapping pause to SIGSTOP would change behavior. SIGSTOP also has no Windows equivalent and pauses computation rather than applying output backpressure. Before defaulting to Bun, either Bun must expose read flow control or Orca must adopt a separately proven bounded strategy that preserves the negotiated output-pause contract on every platform.

### Why Windows needs its own gate

Orca's `node-pty` patch adds per-PTY job ownership, kernel-backed job membership, exact descendant teardown, and ConPTY fixes. `Bun.Terminal` provides ConPTY I/O but does not expose those job handles. A green echo test does not prove close, crash cleanup, detached-child liveness, wide-character repaint, or process-tree ownership.

Windows stays on the legacy daemon until a Bun backend passes the existing native capability oracle and the daemon's real process-tree tests. Do not label handshake coverage as `pty-spawn`.

## Migration without stranding users

No live PTY needs to move between backends.

1. **Additive metadata.** Add optional runtime/backend health fields and optional activation-record runtime metadata. Old peers ignore them; new peers treat absence as legacy/unknown.
2. **Ship slot-local Bun dark.** Build, hash, upload, and smoke-load it without changing the active runtime.
3. **Canary the orcad process.** Run orcad under slot-local Bun while explicitly retaining the legacy Node daemon. This proves RPC, persistence, watchers, detached fork/IPC, and rollback separately from terminal-backend risk. It requires a Bun-native implementation of `WebSocketTransport`; the current `ws` server over Bun's `node:http` stalls upgrades.
4. **Add the Bun daemon backend behind an explicit capability/flag.** Keep the daemon protocol and endpoint layout unchanged.
5. **Preserve live legacy daemons.** The existing rule remains load-bearing: a stale daemon with live sessions is adopted, never replaced. It continues serving those sessions under Node. When its session count reaches zero, orcad may retire it and launch the Bun daemon.
6. **Make Bun the default only after the platform matrix is green.** Rollback starts each slot with that slot's recorded runtime. A Bun daemon must remain protocol-compatible with the immediately previous Node orcad so rollback can adopt it.
7. **Remove Node/node-pty artifacts after the mixed-version window.** Removal is last, after supported clients no longer create legacy daemons and telemetry/health shows none active.

Persistent state, pairing credentials, terminal session IDs, daemon socket names, and RPC frames do not change. Backend identity is diagnostic metadata, not a new terminal stream opcode. If a new opcode becomes necessary, capability-negotiate it; unknown opcodes are silently dropped by old decoders.

## Acceptance gates before cutover

- Bundled, checksum-pinned Bun runs on macOS x64/arm64, Linux glibc x64/arm64, Linux musl x64/arm64, and Windows x64/arm64.
- Existing orcad lifecycle E2E passes under Bun: real pairing, PTY, output, graceful runtime restart, same daemon PID, reattach, retained scrollback.
- Old Node daemon + new Bun orcad and new Bun daemon + old Node orcad both pass.
- Output-pause flood test proves bounded memory and no silent output loss.
- Shell-ready/startup-command delivery passes without a PTY slave path.
- Foreground agent detection, sleep, close, crash cleanup, and detached descendants pass on every platform.
- Windows native capability oracle, wide-character repaint, job membership, and exact tree termination pass.
- Activation rollback starts the incumbent with its own runtime and leaves `live` sessions live; loss of contact remains `unverifiable`.
- Real-host deploy installs the slot-local runtime, activates only after `pty-spawn` health, then survives an orcad restart.

## Next implementation slice

Implement a Bun-native `WebSocketTransport` behind the existing `RpcTransport` contract and rerun the Node-daemon-to-Bun-orcad adoption POC. Keep the current Node transport as the default. After RPC reattach passes, build the internal Bun `SubprocessHandle` adapter behind an explicit development flag. Output backpressure and Windows job ownership remain blockers before changing the default or deleting `node-pty`.
