# Claude transcript cursor-integrity P1 fix

## Outcome

Child HEAD is `f2cca94c0272a5930858f8d42796d4b22c3f69fb`, with the immutable
parent requested by dispatch. This child closes the two remaining proven
transcript cursor-integrity holes without changing the JSONL/snapshot journal,
lease/fence/lifecycle, account-root, resume-identity, approval/question,
cancel/error, or legacy/native toggle-off contracts.

1. Root re-proof now retries only for the typed `ClaudeTranscriptTailIncompleteError`
   and `ClaudeTranscriptPreviousCursorMissingError` cases. A proof that established
   a sibling branch, malformed durable content, invalid ancestry, a wrong session,
   or a sidechain cursor is not retried from the root, so a divergent marker cannot
   be accepted or persisted as the new cursor.
2. Previous-cursor proof now validates the cursor's complete `parentUuid` ancestry
   before accepting either `same` or `descendant` relationships. A cursor whose
   ancestry crosses a `parent_tool_use_id` sidechain is rejected even when the
   latest marker equals that cursor or is a descendant of it. Graceful close and
   first-hand crash persistence consequently retain the last observed main-line
   cursor when durable proof rejects the sidechain.

## Exact files changed

- `src/main/claude/claude-transcript-branch-proof.ts`
- `src/main/claude/claude-structured-session-recovery.test.ts`
- `src/main/native-chat/session-file-resolver.test.ts`
- `CLAUDE-TRANSCRIPT-CURSOR-INTEGRITY-P1-FIX-REPORT.md`

No source/dependency files outside transcript proof, close/crash adapter tests,
and this report were changed. `pnpm-lock.yaml` was restored byte-for-byte to the
parent and has an empty diff.

## Red-first proof

Before implementation, the newly added tests failed in the expected ways:

- A root → `subagent(parent_tool_use_id)` → `main-after` graph resolved a
  sidechain-descended previous cursor for both the `same` and descendant-marker
  cases.
- A root → `old` and root → `new` sibling graph caused the re-proof helper to
  call the root fallback and accept `new`, rather than preserving the sibling
  rejection.

The post-fix tests assert the initial sibling proof rejects, the fallback is not
called for that typed-divergence error, and close/crash persistence retains the
observed leaf instead of the divergent or sidechain leaf. Existing valid
main-line same/descendant, stale-tail, malformed-tail, and parent-tool-use
sampling tests remain green.

## Verification

- Focused resolver/recovery suites (`session-file-resolver.test.ts` and
  `claude-structured-session-recovery.test.ts`): 2 files, 38 tests passed.
- Relevant Claude/router/session suites (direct Vitest invocation; 10 explicit
  test files): 10 files, 103 tests passed.
- Claude child-process/TUI lifecycle checks (`claude-agent-sdk-exit-proof.test.ts`,
  `claude-agent-sdk-process-spawn.test.ts`, `claude-tui-exit.test.ts`, and
  `claude-tui-resume-proof.test.ts`): 4 files, 41 tests passed.
- Node typecheck (`pnpm run typecheck:node`) passed.
- Web typecheck (`pnpm run typecheck:web`) passed.
- Changed-code quality gate passed with zero new findings.
- Changed-file `oxfmt --check` and `git diff --check` passed.
- The broader Claude-directory run had two environment-dependent failures
  (real-CLI credential/init timeout and a timing-sensitive SIGTERM-resistant
  descendant test); the focused process/lifecycle rerun passed, and neither
  failure touches this diff.

## Five-finding disposition

- Prior P1 #1, parent-tool-use/sidechain UUID sampling: fixed on the immutable
  parent; this child preserves the filter and adds the missing previous-cursor
  ancestry proof.
- Prior P1 #2, Claude Code SDK system-prompt preset: fixed on the immutable
  parent; no regression found.
- Prior P1 #3, router close ownership/retry: fixed on the immutable parent; no
  regression found.
- Current P1 #4, unrestricted root re-proof after any cursor error: fixed here
  with typed stale-tail/previous-cursor-missing gating and sibling fail-closed
  coverage.
- Current P1 #5, sidechain-descended previous cursor accepted for same/descendant
  marker relationships: fixed here with complete previous ancestry validation
  and close/crash persistence coverage.

Grouped-answer, local-image, and cleanup-retry leads remain out of scope unless
future evidence proves a regression; no such regression was found in this child.

## Lineage and artifact checks

- `git rev-parse HEAD` before the child fix commit:
  `f2cca94c0272a5930858f8d42796d4b22c3f69fb`.
- Child worktree is at the requested branch/parent lineage; the immutable
  parent SHA was not edited.
- `git diff --name-status` contains only the three modified test/proof files
  above (plus this report); there are no deletions.
- No pre-existing untracked artifacts were edited or removed. The only new
  artifact is this report, retained for coordinator handoff.
