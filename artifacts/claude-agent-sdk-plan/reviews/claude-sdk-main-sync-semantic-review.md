# Claude SDK semantic main-sync review

## Sync identity

- Child branch: `brennanb2025/claude-sdk-main-sync-semantic`
- First parent (Claude child tip): `0fce4ef5ee7a972d327735844f32313ce9547ef2`
- Pinned `origin/main` and second parent: `d05dd8ef50eb33b7e7fe6d3e1f16988d04538a88`
- Merge-base recorded before mutation: `08c7152ab6e576951b33c2991ed2dedca4333096`
- Pre-merge branch diff: 173 paths, 19,984 insertions and 255 deletions versus the pinned main (the SDK/session work is branch-owned).
- Merge conflicts: only the expected modify/delete pair for `src/renderer/src/lib/structured-native-chat-availability.ts` and its test; both were resolved by accepting main's deletion.

## Handoff-only predecessor disposition

The old direct-create surface was branch glue around an availability helper. Main's generic `agentSession.createSupport`/`agentSession.create` route and its existing structured launch pipeline now own routing, capability checks, tab publication, and fallback. The exact path decisions are:

| Path                                                                                   | Disposition                                              | Rationale                                                                                                                                |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/components/native-chat/use-structured-agent-session-create.ts`       | Deleted                                                  | The hook read the removed availability helper, performed a second renderer-side create route, and bypassed the main-owned generic route. |
| `src/renderer/src/components/native-chat/use-structured-agent-session-create.test.tsx` | Deleted                                                  | Test only covered the deleted direct-create hook.                                                                                        |
| `src/renderer/src/components/tab-bar/QuickLaunchButton.tsx`                            | Replaced with exact `origin/main` version                | Removes branch-only Claude/Codex “Chat session” rows and retains main's launch pipeline/watchdog behavior.                               |
| `src/renderer/src/components/tab-bar/QuickLaunchButton.test.ts`                        | Replaced with exact `origin/main` version                | Removes assertions for the deleted direct-create rows and hook mocks.                                                                    |
| `src/renderer/src/lib/structured-native-chat-availability.ts`                          | Deleted (main deletion)                                  | Main's resolver and host adapter capability gate supersede the helper.                                                                   |
| `src/renderer/src/lib/structured-native-chat-availability.test.ts`                     | Deleted (main deletion)                                  | Test for the superseded helper.                                                                                                          |
| `src/renderer/src/lib/windows-terminal-capabilities.ts`                                | Replaced with exact `origin/main` version                | Drops the cache reset added solely for the old renderer availability gate.                                                               |
| `src/renderer/src/lib/windows-terminal-capability-read.ts`                             | Replaced with exact `origin/main` version                | Drops the direct `runtime.getStatus()` process-start cache; host adapter support remains authoritative.                                  |
| `src/main/runtime/orca-runtime-get-status.ts`                                          | Removed branch-only Windows process-start field producer | No current-main consumer remains after removing the old renderer gate; avoiding a stale wire contract.                                   |
| `src/main/runtime/orca-runtime-status-windows-process-start-time.test.ts`              | Deleted                                                  | Characterized the removed producer field, not the main-owned adapter gate.                                                               |
| `src/shared/runtime-session-contracts.ts`                                              | Removed `windowsProcessStartTimeAvailable` field         | Keeps the shared contract aligned with current main after the producer/consumer removal.                                                 |
| `src/renderer/src/i18n/locales/en.json`                                                | Removed four unused QuickLaunch direct-create keys       | Retains main QuickLaunch strings plus structured-setting and handoff copy still used by preserved code.                                  |

All other branch paths, including the Claude SDK adapter/session implementation and handoff UI, are retained. Main-owned launch files (`agent-launch-routing.ts`, `launch-agent-in-new-tab.ts`, work-item/folder creation routes, and their tests) are present at the exact pinned-main content after the merge.

## Main ownership and semantic evidence

- `src/renderer/src/lib/agent-launch-routing.ts` is the single launch decision point. It honors `experimentalNativeChat` and `experimentalStructuredNativeChat`, requires the structured runtime capability, and returns `legacy-native-chat` or `terminal-tui` on refusal.
- The resolver requires `executionHostId === 'local'`, rejects floating workspaces, WSL and repair-required project runtimes, explicit TUI customization, and initial session options. Folder workspaces remain supported. SSH and paired-runtime ownership therefore falls back to the legacy path instead of starting a local session.
- `src/renderer/src/lib/launch-agent-in-new-tab.ts` and the work-item/folder creation callers use that resolver and preserve the existing terminal startup fallback; no parallel entrypoint was added.
- Host-side `agentSession.createSupport`/`create` in `src/main/runtime/rpc/methods/structured-agent-session.ts` resolves the execution location, installs the generic host, and publishes the structured tab. `OrcaRuntimeWithResolveRecoveredStructuredTuiTranscript` resolves folder/git-worktree paths and account roots before attach.
- `StructuredAgentSessionAdapterRouter` routes the generic host to the retained Codex or Claude adapter. Claude reaches the SDK through `structured-claude-runtime-adapter.ts` and `ClaudeStructuredSessionAdapter`; no provider-specific renderer route is required.
- `supportsClaudeStructuredLocation` (and the retained Codex equivalent) requires local, non-WSL execution and, on Windows, `isWindowsProcessStartTimeAvailable()`. This is host-local process identity gating, so Windows falls back safely when proof is unavailable.

Focused route tests pass for toggle-off/native-off behavior, SSH and paired-runtime ownership, legacy fallback, folder support, floating/WSL/repair/Windows refusal, and capability absence. Claude location-support and generic create-intent tests cover the host gate and folder/account resolution.

## Claude SDK correctness retained

The branch-only SDK graph and correctness code remain reachable and unchanged by the routing cleanup: provider identity/resume and transcript leaf proof; JSONL stream connection, journal translation/reconciliation and block identity; lifecycle lease/fence/acquisition/exit proof and recovery; account/config roots and launch environment; approvals, questions, cancellation, options, errors, and user-message queueing. The generic RPC/host/router path above reaches these modules for `agent: 'claude'`.

## Dependency provenance

- `package.json` retains the intentional `@anthropic-ai/claude-agent-sdk` `0.3.251` dependency.
- `pnpm-workspace.yaml` retains the SDK optional-binary exclusions; no generated lock edits were made during this sync.
- Final `pnpm-lock.yaml` SHA-256: `d7e353294affec7c2e4636a4bf39092cc7b0c8366cf6828ff0556fe66c6981c6` (the lockfile passed `pnpm install --frozen-lockfile --ignore-scripts --offline`; pnpm added an environment-only `@pnpm/exe` entry despite frozen mode, and that harness mutation was restored before and after commit).

## Verification

- Focused launch/route/QuickLaunch: 3 files, 46 tests passed.
- Generic structured create and Claude location support: 2 files, 7 tests passed.
- Structured-chat guard/direct work-item routing: 2 files, 13 tests passed.
- Claude main tests: 59 files, 517 passed, 2 skipped.
- Runtime structured/Claude integration: 11 files, 72 passed.
- Agent-session wire suite: 45 files, 268 passed.
- `pnpm tc:node` passed; `pnpm tc:web` passed.
- `pnpm run check:code-quality:changed` passed (0 new findings; 593 changed files, including the pinned-main merge).
- `oxfmt --check` passed on 163 changed files; max-lines ratchet passed with 12 grandfathered suppressions and no new bypasses.
- `git diff --check` and `git diff --cached --check` passed.

## Final commit and state

- Merge commit: `c223c4cbf00e51192482a4eed7b3c4098dff534a`
- Tree: `34f8d12b5db348225f054f6624a796147b676fb0`
- Parents, in order: `0fce4ef5ee7a972d327735844f32313ce9547ef2` and `d05dd8ef50eb33b7e7fe6d3e1f16988d04538a88`
- The report was filled with these exact identifiers in one amend; visible history contains this single merge commit only.
- Tracked state is clean, with no untracked files. No accidental deletion/rebase loss or scope expansion was found; only the documented predecessor glue was removed. No Electron or mobile QA was in scope; no mobile interaction tooling was used.
