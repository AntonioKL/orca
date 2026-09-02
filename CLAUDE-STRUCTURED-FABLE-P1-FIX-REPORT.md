# Claude structured Fable P1 fix

## Outcome

Fixed the three release-blocking findings against parent `bf5c9604640e8462814829dfec0b35ff2b612d96`:

1. Structured Claude leaf sampling now rejects stdout `user`/`assistant` UUIDs with a non-null `parent_tool_use_id`, and transcript branch proof marks those rows as disallowed. If a durable close or first-hand crash proof rejects the sampled cursor, the adapter re-proves from `previousLeafUuid: null` and persists the valid main-transcript leaf when available. Existing bounded ancestry, malformed-tail, sibling-branch, and resume protections remain fail-closed.
2. Structured SDK launches now carry `systemPrompt: { type: 'preset', preset: 'claude_code' }` in the base options. The connection test injects the SDK query boundary and pins the option passed to initialization, while account/config roots, setting sources, and the legacy CLI path remain unchanged.
3. `StructuredAgentSessionAdapterRouter.closeSession` retains the adapter owner when close is false/unproven and removes it only after an exact `closed === true`, allowing a later retry to reach the same provider adapter.

## Exact files changed

- `src/main/claude/claude-stream-json-connection.test.ts`
- `src/main/claude/claude-stream-json-connection.ts`
- `src/main/claude/claude-structured-launch-resolution.test.ts`
- `src/main/claude/claude-structured-launch-resolution.ts`
- `src/main/claude/claude-structured-session-adapter.ts`
- `src/main/claude/claude-structured-session-close.ts`
- `src/main/claude/claude-structured-session-recovery.test.ts`
- `src/main/claude/claude-transcript-branch-proof.ts`
- `src/main/claude/claude-tui-exit.test.ts`
- `src/main/claude/claude-tui-exit.ts`
- `src/main/native-chat/agent-session-wire/structured-agent-session-adapter-router.test.ts`
- `src/main/native-chat/agent-session-wire/structured-agent-session-adapter-router.ts`
- `src/main/native-chat/session-file-resolver.test.ts`

## Red-first tests and verification

The new tests were run before implementation and failed for each targeted behavior: parent-tool-use UUIDs were sampled/accepted, stale-cursor recovery retained the old leaf, the base system prompt was absent, and router ownership was dropped after a false close. After implementation:

- Focused P1 suites: 6 files, 69 tests passed.
- All Claude suites plus router/session resolver: 60 files, 512 tests passed, 2 skipped.
- Node typecheck: `node_modules/.bin/tsc --noEmit -p config/tsconfig.node.json` passed.
- Web typecheck: `node_modules/.bin/tsc --noEmit -p config/tsconfig.tc.web.json` passed.
- Native changed-area Oxlint with warnings denied passed.
- Changed-code quality gate passed with zero new findings across 13 files.
- Changed-file `oxfmt --check` and `git diff --check` passed.
- `pnpm-lock.yaml` was restored byte-for-byte to the parent and has no diff.

## Five-finding disposition

- Sidechain/subagent UUID and stale-cursor recovery: proven P1, fixed here; graceful close and first-hand crash regressions are covered.
- Missing Claude Code system prompt: proven P1, fixed here; the SDK query boundary is pinned.
- Router close ownership loss: proven P1, fixed here; false-then-true close retry is covered.
- Grouped-answer handling: proven separately and already fixed on the parent by the existing grouped-question change/report; no regression or scope overlap was found here, so it is dismissed from this dispatch.
- Local-image and cleanup-retry leads: reviewed as existing, unrelated paths; neither is changed or regressed by this diff, so both are dismissed from this dispatch (no new release-blocking evidence).

## Harness/environment and artifact notes

The repository's pnpm bootstrap added an `@pnpm/exe` lockfile entry while invoking pnpm commands; it was removed and the lockfile was rechecked clean. No Electron/mobile UI flow applies to these main-process/adapter changes. No pre-existing untracked artifacts were edited or deleted; the child remains at the requested parent lineage with only the source, tests, and this report changed.
