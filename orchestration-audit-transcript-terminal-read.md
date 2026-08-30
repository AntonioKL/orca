# Transcript / terminal-read audit

Scope: current `orchestration-v3` HEAD; read-only audit, no production edits.

## Keep

- **Execution-host authority.** `readWorkerTranscript` accepts a remote filesystem provider only with the hook-attested `transcriptPath`; it explicitly refuses local provider-root search (`src/main/runtime/orchestration/worker-transcript-read.ts:62-78`). WSL sessions stay on the local guarded resolver with an attested distro, while SSH sessions are routed through `getSshFilesystemProvider` (`src/main/runtime/rpc/methods/orchestration-worker-output.ts:39-71`).
- **Race fences.** Local reads capture file identity before/after and hash a 64-byte boundary checkpoint; forward reads revalidate path and open-handle identity (`worker-transcript-local-read.ts:46-75, 87-145`; `worker-transcript-source-identity.ts:15-58`). Remote ranged reads re-stat, verify boundary bytes, and reject changed identity; unsupported range capability degrades once to the bounded SSH whole-file path (`worker-transcript-remote-range-read.ts:49-112`; `worker-transcript-remote-read.ts:82-111`).
- **Source-pinned worker output.** Exact worker reads validate provider session before and after transcript reads and pin opaque cursors to process/session/path identity (`rpc/methods/orchestration-worker-output.ts:39-139`). Fallback terminal reads are labeled `source: terminal`, `sourceExact: false`, and preserve fallback reasons (`:142-220`).
- **Terminal screen/stream distinction.** `terminal.read` rejects cursor+screen at the RPC schema (`rpc/methods/terminal/unary-schemas.ts:40-76`), labels every response source, and CLI refuses an old host that silently drops `screen` (`cli/handlers/terminal.ts:72-105`). Provider snapshots are timeout-bounded/shared and stale generations or output sequences are discarded (`orca-runtime.test.ts:19191-19207, 19241-19257, 19284-19309, 19358-19389`).

## Simplify

- Local initial transcript reads use the tail reader and return `limited: page.hasMore` with `nextOffset: consumedTo` (normally EOF), but emit no explicit warning that omitted older records cannot be paged (`worker-transcript-local-read.ts:53-75`). The remote implementation does emit that warning when its bounded EOF window clips history (`worker-transcript-remote-read.ts:205-213`), and the formatter test expects such wording (`cli/handlers/orchestration/worker-output.test.ts:5-53`). Add a local regression asserting `contentComplete`, `clipping`, and warning semantics, or make local and remote clipping metadata consistent.
- Add CLI regression coverage for `terminal read --screen`: current tests cover only schema rejection/acceptance (`rpc/methods/terminal-read-screen-cursor.test.ts:12-42`), not old-host source absence or `screen-unavailable` formatting.

## Defer (not block)

- Remote source identity fingerprints only `(dev, ino)` and same-size changes rely on mtime plus a 64-byte boundary hash (`worker-transcript-source-identity.ts:15-58`). A same-size rewrite outside that boundary with coarse/unchanged remote mtime is theoretically undetectable; add a test if providers ever compact transcripts in place.
- Local initial tailing inherits the native reader's unbounded backward scan when malformed records never increment the valid-message count (`native-chat/transcript-tail-reader.ts:86-153`); a very large malformed file can cost a full-file scan, but no user-impacting case is evidenced in this PR.

## Evidence

Targeted suite passes: `pnpm test src/main/runtime/orchestration/worker-transcript-read.test.ts src/main/runtime/orchestration/worker-transcript-remote-read.test.ts src/main/runtime/rpc/methods/orchestration-worker-output.test.ts src/main/runtime/rpc/methods/terminal-read-screen-cursor.test.ts` (4 files, 34 tests).

Existing tests cover split EOF append, bounded >8 MiB remote tails, legacy SSH fallback, same-inode replacement, WSL/SSH routing, payload redaction, source-pinned cursors, and stale provider snapshots (`worker-transcript-read.test.ts:37-274`; `worker-transcript-remote-read.test.ts:67-359`; `orchestration-worker-output.test.ts:37-357`; `orca-runtime.test.ts:19191-19389`). No correctness blocker found.
