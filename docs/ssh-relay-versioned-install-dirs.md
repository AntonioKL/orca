# SSH relay versioned install directories

Every relay build installs into its own immutable directory on the remote host, named after a
hash of the bundle's own bytes. That one decision determines where the relay's socket lives,
what garbage collection is allowed to delete, whether a client may talk to a relay it did not
deploy, and what happens to remote work when Orca updates. This page is the reference for all
of it. Six source files cite it; keep them in sync.

Companion pages: [`reference/ssh-execution-boundary.md`](./reference/ssh-execution-boundary.md)
(who owns execution state, and the `live` / `unverifiable` / `exited` vocabulary) and
[`reference/remote-wire-compatibility.md`](./reference/remote-wire-compatibility.md) (rules for
changing anything two peers exchange).

## The scheme

The remote layout is:

```
~/.orca-remote/                               RELAY_REMOTE_DIR (relay-protocol.ts:31)
  relay-0.1.0+0a5fe134d020/                   one immutable install per bundle
    relay.js, relay-watcher.js, …             RELAY_ARTIFACTS (relay-artifacts.ts:45-58)
    .version                                  "0.1.0+0a5fe134d020"
    .install-complete                         written last; absence = torn install
    relay-<sha256(targetId)[0:16]>.sock       the endpoint
    relay-<…>.sock.credential
    agent-hooks/<sockname>/
  orcad-<version>/                            permanent sibling, different owner
```

`computeRemoteRelayDir` (`src/main/ssh/ssh-relay-versioned-install.ts:75`) builds the path from
two validated segments — `.orca-remote` and `relay-<fullVersion>` —
via `remoteInstallDirSegments` (`ssh-relay-install-namespace.ts:47-64`). Both the shell builder
and the SFTP-relative builder go through that one function so the two namespaces cannot drift,
and every segment is checked for path and CR/LF metacharacters because it is interpolated into
remote shell, `awk`, and PowerShell.

`fullVersion` is `${RELAY_VERSION}+${contentHash}`. `RELAY_VERSION` is the literal `'0.1.0'`
(`src/main/ssh/relay-protocol.ts:28`, mirrored at `src/relay/protocol.ts:27`). `contentHash` is
the first 12 hex characters of a SHA-256 over every declared artifact, concatenated in
`RELAY_ARTIFACTS` order (`config/scripts/build-relay.mjs:199-217`); optional artifacts are
hashed only when the build emitted them, so a relay carrying the Windows process-table addon and
one that falls back to the PowerShell scan never share a directory. The hash inputs are exactly
the names declared in `RELAY_ARTIFACTS`, and `.version` is written afterwards, so it is never an
input to itself (`build-relay.mjs:235`, `src/shared/relay-artifacts.ts:60-61`).

**Why a content hash and not a semantic version.** The build comment states it directly
(`build-relay.mjs:195-197`): the deploy check must detect code changes even when `RELAY_VERSION`
has not been bumped, and hashing the whole artifact manifest means a companion-only change (a
watcher fix, a hook runtime fix) still selects a fresh directory. In practice `RELAY_VERSION`
has never moved, so the hash is the only thing that distinguishes builds.

What that buys:

- **Immutability.** A directory name implies its bytes. The header of
  `ssh-relay-versioned-install.ts:1-3` gives the motivating failure: an in-memory daemon serving
  new clients off on-disk code that was overwritten underneath it. Modelled on VS Code's
  `~/.vscode-server/bin/<commit>/`.
- **Cheap idempotent deploys.** `isRelayAlreadyInstalled` (`ssh-relay-versioned-install.ts:99`)
  probes for the required artifacts plus the `.install-complete` sentinel; a match skips the
  upload entirely, and any missing artifact forces a full re-deploy rather than a patch.
- **One identity for three purposes.** The same string is the directory name, the wire handshake
  version, and the PTY-grant build id — see [Four enforcement points](#four-enforcement-points).

Native dependencies (`node-pty`, `@parcel/watcher`) are installed and compiled **into the version
directory** too (`installNativeDeps`, `ssh-relay-deploy.ts:951-1026`), so each install carries
its own addons and a rebuild can never affect another version. One naming consequence lives
there: `npm init -y` rejects the `+` in a content-hashed directory name, so deploy writes a fixed
minimal `package.json` instead (`ssh-relay-deploy.ts:984`). A failed post-install `require()`
probe is deliberately **non-fatal** — deploy logs `[ssh-relay][NPTY-MISSING]` and finalizes the
install anyway (`ssh-relay-deploy.ts:1103-1108`), because the relay still serves fs/git/preflight
and throwing would loop reconnects forever on a host that cannot build the addons. The optional
Windows process-table addon is treated the same way: hashed when present, never probed
(`src/shared/relay-artifacts.ts:54-57`).

The client refuses to guess it: `readLocalFullVersion` (`ssh-relay-versioned-install.ts:48-67`)
throws when `.version` is missing or empty rather than falling back to a bare `0.1.0`, because
that fallback path may already have a stale-generation daemon running on it
(`ssh-relay-deploy.ts:378`).

`relay-<v>` and `orcad-<v>` are permanent siblings under one `.orca-remote/`
(`src/main/ssh/remote-install-model.ts:1-13`), which is why the prefix is a model parameter.
Ownership is enforced: `remoteInstallDirOwner` / `remoteInstallGcPermits`
(`remote-install-model.ts:100-135`) mean a relay GC pass can never see or delete an orcad tree.

## Where the socket lives

On POSIX the endpoint is a unix socket **inside the version directory**
(`src/main/ssh/ssh-relay-deploy.ts:1385`, `relayEndpointForHost` at
`ssh-relay-endpoints.ts:11-17`). Its name is `relay-<sha256(targetId)[0:16]>.sock`, or
`relay.sock` when no relay instance id is supplied (`ssh-relay-instance-id.ts:3-9`) — one
version directory is shared by every Orca target on that account, and hashing the target id into
the socket name is what stops cross-target attach (`ssh-relay-deploy.ts:1383`). The endpoint
credential (`<sockname>.credential`, `ssh-relay-deploy.ts:1387`) and the agent-hook endpoint
directory (`relayHookEndpointDirForHost`, `ssh-relay-endpoints.ts:26-37`) sit beside it.

On Windows there is no filesystem socket: the endpoint is a named pipe
`\\.\pipe\orca-relay-<sha256(remoteDir\0sockName)[0:20]>` (`ssh-relay-endpoints.ts:18-24`). The
version directory is still an input to that hash, so pipes are version-scoped too — but a pipe
leaves nothing inside the directory.

**Why inside the version directory: garbage collection reads liveness from in there.** GC's
`isDirLive` hook for the relay is `hasLiveRelaySocket` (`remote-install-gc.ts:256`), and the
command it runs (`relayLivenessProbeCommand`, `ssh-remote-commands.ts:208-219`) globs
`<dir>/relay-*.sock` and `<dir>/relay.sock` and answers `ALIVE`/`DEAD` from `test -S` alone —
deliberately not a connect-and-close probe, which would race a daemon about to idle out. So
"which install directory is in use" is answered purely by looking inside it; nothing has to
enumerate remote processes.

Windows has to restore that property artificially. Because the pipe is not in the directory, the
running relay writes a `.windows-active-pipe-<sockname>` marker file into the version directory
(`windowsActivePipeMarkerPath`, `ssh-relay-endpoints.ts:50-61`) and the Windows branch of the
liveness probe reads those markers back out and connect-probes each pipe
(`ssh-remote-commands.ts:220-238`). The marker exists solely so the same "liveness is discoverable
from inside the directory" rule holds there.

Endpoint placement and GC safety are therefore a single decision. Moving the socket out of the
version directory — the obvious first step toward a stable, build-independent endpoint —
invalidates the liveness probe and needs a replacement designed at the same time.

## Four enforcement points

A client and a relay of different builds cannot reach each other. This is not enforced once; it
is enforced four independent times, so the structural guarantee survives any one of them being
bypassed.

| # | Point | Mechanism |
| --- | --- | --- |
| 1 | The path itself | The client only ever computes `remoteDir` from its own `fullVersion` (`ssh-relay-deploy.ts:378-379`). A different build addresses a different directory, hence a different socket or pipe. There is nothing to refuse because there is nothing to reach. |
| 2 | Wire handshake | The daemon compares the client's handshake `version` against its own `launchVersion` and closes on inequality (`src/relay/relay-handshake.ts:126`). |
| 3 | PTY consumer grant | The client re-checks `protocolVersion` and `serverBuildId` on every `pty.openClient` grant and throws on mismatch (`src/main/ssh/ssh-pty-consumer-session.ts:58-65`). |
| 4 | Owner-claim recovery | A persisted PTY owner claim is reusable only when its recorded `serverBuildId` equals the current one (`src/main/ssh/ssh-relay-session.ts:1136-1147`). |

**Point 2 in detail.** `launchVersion` is `readLaunchVersion()` — `.version` read beside the
*resolved* script path, not the launch cwd (`relay-handshake.ts:19-46`, wired in at
`relay-daemon.ts:43-47`). On inequality the daemon writes an `orca-relay-handshake-mismatch`
frame and ends the socket; the `--connect` bridge prints the detail and exits with
`EXIT_CODE_VERSION_MISMATCH = 42` (`relay-handshake.ts:203-213`). The client maps exit 42 into a
typed `RelayVersionMismatchError` (`ssh-relay-deploy-helpers.ts:139-149`,
`ssh-relay-handshake-mismatch.ts:6-14`), which the reconnect loop treats as terminal rather than
retrying with backoff (`ssh-relay-version-mismatch-error.ts:1-8`; handled at
`ssh-relay-session.ts:632` and `:786`).

Given point 1, a mismatch here should be unreachable — the same directory implies the same
`.version` — and the source calls this check defense-in-depth (`relay-handshake.ts:164`). The
one reachable route is a `.version` that could not be read when the daemon launched:
`readLaunchVersion` falls back to bare `RELAY_VERSION` (`relay-handshake.ts:45`), which never
equals a client's `0.1.0+<hash>`.

**Point 3 in detail.** The relay stamps its `launchVersion` into every grant as `serverBuildId`
(`relay-runtime-services.ts:36-43`, `src/shared/pty-consumer-session.ts:85-86`); the client's
expected value is the `fullVersion` returned by deploy (`ssh-relay-deploy.ts:594`). The comment
at `ssh-pty-consumer-session.ts:78-79` states the invariant this whole scheme creates —
*"client and relay ship in one build"* — and uses it to conclude that a missing field in a grant
is corruption rather than an older peer. That reasoning is only valid while the scheme holds.

## What that costs

After an Orca update the content hash changes, so the client computes a new directory, a new
socket path, and launches a fresh daemon. **Nothing above stops the previous daemon.** It was
launched detached (`nohup … </dev/null &`, `ssh-relay-deploy.ts:1464-1471`) precisely so remote
work survives the client going away, and its PTYs are its children. The shipped default grace
period is `0` = keep alive until reset (`src/shared/ssh-types.ts:9`), so no timer reclaims it
either.

The result is work that does not stop and can never be addressed again:

- The new client never computes the old path (point 1), so it never even attempts a reconnect.
- If it somehow did, points 2–4 would refuse it.
- GC will not remove the old tree, because `hasLiveRelaySocket` correctly sees the live socket
  and returns `ALIVE` (`remote-install-gc.ts:256-285`).

Per [`reference/ssh-execution-boundary.md`](./reference/ssh-execution-boundary.md) the verdict
for that work is **`live`**, not `exited`. Losing the ability to address a process is not
evidence of its death, and the doc's rule against collapsing `unverifiable` into `exited`
applies here directly. The user sees terminals come back as fresh shells; the old ones are still
running.

This is tracked as issues #8585, #13614, and #13852. The real fix named in PR #17821 —
replacing the build-content-hash `launchVersion` with a semantic protocol version plus a stable,
version-independent socket path — is a wire change requiring capability negotiation and has not
been attempted.

## GC, and the socket-unlink hazard

`gcOldRelayVersions` (`remote-install-gc.ts:240-254`) runs fire-and-forget after a successful
launch, with errors swallowed so GC can never block a connect (`ssh-relay-deploy.ts:578-590`).
It is conservative by construction:

- The remote listing is prefix-scoped and capped, and `remoteInstallGcPermits` re-checks every
  candidate client-side (`remote-install-gc.ts:104-113`).
- The current directory is pinned and never a candidate (`remote-install-gc.ts:89`, `:109`).
- A locked directory is skipped unless the lock is provably stale, and a directory without
  `.install-complete` is left for the next deploy to recover (`remote-install-gc.ts:200-232`).
- An inconclusive liveness probe returns `true` — never evidence a tree is idle
  (`remote-install-gc.ts:282-284`, and the `isDirLive` contract at `:60-63`).

**The hazard is on the relaunch path, not in GC.** Before launching a fresh POSIX relay, deploy
probes `test -S <sock>`; if the socket is alive it runs `relay.js --connect` to re-attach and
preserve PTY state. Any failure of that reconnect is caught by an **untyped** catch, which logs
and then runs `rm -f <sock>` before falling through to a fresh launch
(`ssh-relay-deploy.ts:1421-1455`, unlink at `:1445-1446`). The catch does not distinguish:

- a genuinely stale inode left by a SIGKILLed relay — the case the comment at
  `ssh-relay-deploy.ts:1445` describes;
- **exit 42**, which is positive proof that a healthy daemon is listening on that socket and
  refused the handshake. `waitForSentinel` builds the typed `RelayVersionMismatchError`, but this
  catch swallows it, so neither typed handler in `ssh-relay-session.ts` is reached;
- a rotated endpoint credential — `writeRelayEndpointCredential` runs on the fresh-launch path
  only (`ssh-relay-deploy.ts:1467`), so an incumbent holding the previous credential fails every
  subsequent handshake with no version change involved.

Unlinking a unix socket does not close the listener the incumbent already holds. Worse, it
defeats the daemon's own guard: on `EADDRINUSE` the relay connect-probes the blocked path and
unlinks only when the inode identity is unchanged and the probe was refused
(`src/relay/relay-socket-ownership.ts:88-112`, `:146-200`). With the inode already removed by the
client, the replacement's `listen()` simply succeeds and the incumbent is never contended with —
it keeps running with its PTYs, now unreachable.

Windows is not affected: `launchRelay` returns from its Windows branch
(`ssh-relay-deploy.ts:1389-1417`) before this block, and a named pipe has no inode to unlink.

**Status.** PR #17821 ("fix(ssh): stop orphaning live relays when an endpoint is taken over") is
**open and unmerged** as of this writing, and its own description flags one behavior change as
still needing a product decision. The behavior described above is what ships today.
The PR removes the client-side unlink entirely and replaces it with a read-only incumbent probe
producing a strict `live` / `unverifiable` / `exited` verdict, letting `RelaySocketOwnership`
remain the authority. It also converts the live-incumbent-holding-work case from a silent leak
into a visible connect failure — an explicit product decision still under review. Do not write
code or docs that assume it has landed.

## Contrast: the terminal daemon

The local terminal daemon solves the same problem — a long-lived process holding PTYs across app
updates — and reaches the opposite conclusion at every step. It is the consolidation target.

| | SSH relay | Terminal daemon |
| --- | --- | --- |
| Endpoint | `~/.orca-remote/relay-<0.1.0+hash>/relay-<hash>.sock` | `<runtimeDir>/daemon-v36.sock` (`daemon-spawner.ts:122-134`) |
| Namespaced by | build content hash — changes on any byte change | semantic `PROTOCOL_VERSION` — bumped deliberately (`daemon-protocol-version.ts:3`) |
| Path stability across builds | none | stable until the protocol version moves |
| Older peers | refused (exit 42) | kept attachable; `PREVIOUS_DAEMON_PROTOCOL_VERSIONS` lists 1–35 (`daemon-protocol-version.ts:31-34`) |
| Feature skew | not expressible — one build on both ends | per-version predicates, e.g. `supportsPtyStartupIngress` (`daemon-protocol-version.ts:36-38`) |
| On app update with live work | old daemon orphaned with its PTYs | replacement refused: `shouldPreserveDaemonWithLiveSessions` (`daemon-replacement-preflight.ts:247-266`) |

The daemon's preservation rule is the sharpest contrast. It replaces only at *exactly* zero live
sessions; a non-zero count preserves, and a `null` count — live state that could not be verified
— also preserves (`daemon-replacement-preflight.ts:247-266`). The relay has no equivalent check
on the update path. The daemon's own header states the premise the relay does not adopt:
*"daemons survive app updates, so wire behavior must be version-gated"*
(`daemon-protocol-version.ts:1-2`).

Windows named pipes on the daemon side carry the protocol version in the name for the same
reason (`\\?\pipe\orca-terminal-host-v36-<hash>`, `daemon-spawner.ts:129-132`) — the version, not
the build.

## Constraints on changing any of this

Read [`reference/remote-wire-compatibility.md`](./reference/remote-wire-compatibility.md) first.
Two constraints are specific to the relay handshake.

**A new handshake message type is not backward compatible.** `parseHandshakeMessage`
(`src/relay/protocol.ts:50-61`) throws on any `type` outside the three it knows, and both sides
destroy the socket on a parse failure (`relay-handshake.ts:113-120`, `:185-194`). Unlike the
terminal stream — where an unknown opcode is dropped silently (Rule 2 of the wire-compatibility
page) — an unknown handshake type is a hard close. The failure is loud but total, and it happens
before any capability could have been advertised, so there is no negotiation step to hang a new
type off.

**Evolve with optional fields on the existing types.** `endpointCredential` is the precedent: it
is an optional field on `orca-relay-handshake` (`src/relay/protocol.ts:41`), sent only when the
client has one (`relay-handshake.ts:231-237`), and checked by the daemon only when the daemon
itself has one, through an `in` guard that tolerates its absence
(`relay-handshake.ts:144-151`). An older peer on either side is unaffected.

Two more things that move together with the version string:

- It is load-bearing in three places simultaneously — directory name, wire handshake version,
  and PTY grant `serverBuildId`. Changing the format changes all three at once, plus the
  persisted owner-claim records that key on it (`ssh-relay-session.ts:1136-1147`).
- Its shape is pinned by remote regex dialects. `VERSION_PATTERN`
  (`remote-install-model.ts:66-72`) is embedded verbatim into a remote `awk` ERE and a PowerShell
  `-match`, which is why it spells `[0-9]` rather than `\d`. A format change must stay
  expressible in all three dialects, or GC and the install listing stop recognizing their own
  directories.
