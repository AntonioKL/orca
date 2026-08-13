# Orca runtime 80/20 peel plan

## Baseline and conclusion

- Source: `src/main/runtime/orca-runtime.ts`, 37,871 lines before extraction.
- `OrcaRuntimeService` itself occupies lines 2,697–35,572 (32,876 lines). Most of that body owns or orders the mutable PTY, renderer/mobile graph, Maps/Sets, waiter, timer, IPC, persistence, and reconciliation state.
- The clearly mechanical pure/stateless surface is about 3,200–3,500 source lines. A safe run therefore projects roughly **34,400–34,700 residual lines**, not 18–22k. Reaching half would require extracting state owners or converting large side-effecting service workflows, contrary to this run's constraints.
- Freeze the list below. Do not compensate for the shortfall by extracting another class workflow.

Impact uses `estimated moved lines / risk weight`, with Low=1, Low–Medium=2, Medium=3. Estimates include retained comments/types/constants but exclude the small imports added to `orca-runtime.ts`.

## Frozen peel list

| Symbol / cluster | Exact current lines and symbols | Est. lines | Pure? | Risk | Impact | Action |
|---|---|---:|---|---|---:|---|
| Terminal retained-tail buffer and read projection → `terminal-tail-buffer.ts` | constants 35,579–35,590 (`MAX_TAIL_*`, preview/read limits); 35,723–35,748 `buildPreview`; 35,752–35,850 restore seed types/functions; 35,941–36,852 retained-tail, ANSI control, transcript, tail equality/read/fallback functions; 37,721–37,835 terminal chunk normalization helpers | ~1,140 | Yes; local allocation or explicit record mutation only | Low | 1,140 | **PEEL FIRST.** Keep exported names re-exported from `orca-runtime.ts` so tests/external imports remain stable. Preserve all performance/quirk comments verbatim. |
| Terminal wait signal detection/result construction → `terminal-wait-signals.ts` | 35,574–35,578 wait constants; 35,852–35,939 wait-state functions/types; 36,892–37,203 idle/prompt/block detection plus result constructors (exclude the unrelated mobile fit constants at 36,901–36,902) | ~390 | Yes; regex/string scans and result construction | Low | 390 | **PEEL FIRST.** Import retained-tail `buildTailLines` or export it internally. Re-export `TerminalTailWaitState`, `computeTerminalTailWaitState`, and `tailGainedNewerBlockedReason` from the original module. |
| Worktree/session identity and summary-path projection → `runtime-worktree-identity.ts` | 37,209–37,578: branch/path/id comparison; incremental lookup; session-id canonicalization; persisted PTY binding indices; set equality; worktree-id parse; summary path index/lookup | ~370 | Yes except explicit mutation of newly supplied index Maps | Low–Medium | 185 | **PEEL FIRST.** Move as one closed cluster. The two indexers only mutate Maps supplied by the caller and retain iteration/insertion order exactly. No conversion to object/grouping utilities. |
| Worktree/agent status projection and sorting → `runtime-worktree-status-projection.ts` | 37,580–37,719 status/title classification/merge; 37,837–37,871 `maxTimestamp`, `compareWorktreePs` | ~175 | Yes; projections over explicit records | Low | 175 | **PEEL FIRST.** Use narrow structural input types or move the private record types with the cluster; do not widen/rename statuses or alter priority/default order. |
| Headless mobile tab/group pure projection → `mobile-session-tab-projection.ts` | methods 5,987–6,044; 6,104–6,157; 6,360–6,462; 6,878–6,925; 6,965–7,028; 7,041–7,289 (`headlessMobileSnapshotContentUnchanged`, recursive value equality, browser order/group assignment, merge/identity/group projection, terminal-tab projection, browser equality, layout/leaf/order/group builders) | ~550 | Closed pure cluster; `deriveHeadlessLegacyTerminalLeafId` has an existing unreachable random fallback | Low–Medium | 275 | **PEEL SECOND**, only after the module-level post-class peels are green. Convert private calls mechanically to imported functions; preserve argument order and comments. Do not include adjacent hydration, persistence, live browser access, retirement, or publication methods. |
| Agent launch matching/copy cluster → `runtime-agent-launch-resolution.ts` | 1,409–1,415 `mergeTerminalEnvDeletionKeys`; 1,422–1,440 operation predicate and deterministic UUID; 1,460–1,527 launch-config copy, command normalization/match, Claude teams mode inference; 1,800–1,814 launch platform projection | ~105 | Yes; hash/string/config projection | Low | 105 | **PEEL SECOND.** Keep operation limits in `orca-runtime.ts` unless both consumers move; move only the listed functions. Keep the SHA/UUID bit math byte-for-byte. |
| Small worktree/review value functions → domain modules (`runtime-worktree-selection.ts`, `selected-review-branch.ts` if ownership fits) | 2,124–2,138 git error predicate; 2,160–2,185 removal key and execution-host match; 2,240–2,251 exact selector; 2,280–2,290 branch normalization/viewport clamp; 2,349–2,390 local git options + selected hosted-review lookup; 35,687–35,693 explicit selector | ~95 | Predicates/projections; hosted-review lookup is stateless async adapter | Low–Medium | 48 | **PEEL SECOND.** Prefer adding review functions to the existing `selected-review-branch.ts`; keep host/provider branching and call signatures unchanged. If import layering becomes circular, leave the async review adapter in place. |
| Cheap internal contract blocks → domain contract modules | 1,105–1,206 `RuntimeStore` → `runtime-store-contract.ts`; 1,647–1,774 `RuntimePtyController` plus 1,776–1,788 inventory identities → `runtime-pty-controller-contract.ts`; 1,872–1,987 `RuntimeNotifier` → `runtime-notifier-contract.ts` | ~370 | Type-only | Low–Medium | 185 | **PEEL LAST.** Internal types only: no public re-export churn, no type reshaping, no optionality changes. Skip any block that creates a runtime import cycle or forces public API changes. |

Projected gross movement is about **3,195 lines** (up to ~3,500 with contiguous comments/type support), for a projected file size of **~34.4–34.7k lines** after new imports/re-exports. The first four rows alone are the highest-confidence batch (~2,075 lines).

## Dependency and import notes

### `terminal-tail-buffer.ts`

- Type imports: `RuntimeTerminalRead`, `RuntimeTerminalState`; a narrow structural restored-record type should replace the dependency on the full private `RuntimePtyWorktreeRecord`.
- Runtime imports: none from `orca-runtime.ts`. Move `normalizeTerminalChunk` and its private callees with this cluster to avoid a back-edge. `buildRestoredTerminalTailSeed` calls it and calls retained-tail/transcript functions.
- Exports required for existing compatibility: `AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS` may remain in `orca-runtime.ts`; `buildPreview`, `buildRestoredTerminalTailSeed`, `appendNormalizedToTailBuffer`, and `appendNormalizedToMultilineTailBufferUnwindowed` must remain importable from `./orca-runtime` through re-export. Keep `RetainedTailRedrawCursor` exported only as needed internally/tests; do not widen the public surface gratuitously.
- Existing characterization coverage: `orca-runtime.test.ts`, `orca-runtime-tail-wait-memo.test.ts`, `retained-tail-redraw-window.equivalence.test.ts`, `terminal-restore-record-seed.test.ts`, and `pty-transcript-prune-wait-cache.test.ts`.

### `terminal-wait-signals.ts`

- Type imports: `AgentStatus`, `RuntimeTerminalWait`, `RuntimeTerminalWaitBlockedReason`, `RuntimeTerminalWaitCondition`, `RuntimeTerminalState`, and the retained-tail cursor/input types as needed.
- Runtime imports: `detectAgentStatusFromTitle`, `isClaudeManagementTitle`, `isCursorAgentTitle`, `isCursorNativeAgentTitle`, `isOpenCodeNativeTitle`, `isQuarterCircleSpinnerOnlyAgentTitle`, and a retained-tail line builder. Verify the exact detector set after the mechanical move with unused-import lint/typecheck.
- Regex state is safe because the relevant regexes do not use `g`/`y`; preserve literal definitions and scan order.

### `runtime-worktree-identity.ts`

- Imports: cross-platform path comparison primitives, `splitWorktreeIdForFilesystem`, `parsePtySessionId`, `parseAppSshPtyId`, `getRepoIdFromWorktreeId`, `FOLDER_WORKSPACE_INSTANCE_SEPARATOR`, plus narrow `Repo`/runtime summary/session binding types.
- Preserve Map insertion order, `setFirstRuntimeWorktreePathCandidate` first-writer semantics, Windows/UNC normalization, SSH connection identity, folder-workspace identities, and exact fallback order.

### `runtime-worktree-status-projection.ts`

- Imports: agent-title detection/classification, `isFreshNonDoneAgentStatus`, runtime worktree/terminal status types, and narrow readonly views of leaf/PTY records.
- Keep `WORKTREE_STATUS_PRIORITY` with `mergeWorktreeStatus`/`compareWorktreePs`. Preserve null handling and stable tie-break order.

### `mobile-session-tab-projection.ts`

- Imports: `createHash`/`randomUUID`, stable pane-id validation, `buildHeadlessTerminalSplitLayout`, and mobile-session/layout/workspace-session types.
- Functions should take the same explicit arguments currently received by each private method. Call-site edits must only remove `this.` and add missing explicit pure-function arguments; no shared object/context parameter.
- Do not move `reconcileHeadlessMobileSessionBrowserTabs`, `buildHeadlessMobileSessionBrowserTabs`, `getPersistedUnifiedSessionTabProps`, or any publication/persistence/retirement method; those read live services or state.

## Explicitly deferred state owners and order-sensitive adapters

| Cluster | Representative current lines | Why deferred |
|---|---|---|
| Core PTY/renderer graph | `OrcaRuntimeService` broadly; especially 9,356–18,193 and 25,501–32,863 | Owns PTY handles, leaves/tabs, generation fences, listeners, emulator/provider state, waiters, timers, and publication order. A safe split requires moving a state owner, out of scope. |
| Managed worktree create/remove/reconcile | 21,795–25,003 | Git/fs/network effects, watcher drains, lifecycle notification order, rollback, host/SSH/folder behavior. Not a pure peel despite high LOC. |
| Mobile floor/layout/session publication | 5,771–8,728; 13,246–15,545; 26,181–30,863 | Live Maps/Sets, renderer authority, subscriptions, persistence fences, resize timers, and publication epochs. Only the enumerated pure projection methods may move. |
| Waiter/message delivery | 17,366–17,633; 31,783–32,627 | Live waiter Maps, abort cleanup, timeout/poll timers, delivery/settlement ordering. |
| Orchestration compatibility/recovery | 3,974–4,548; 12,174–12,396; 31,344–32,627 | Authority receipts, DB settlement, migration and process-incarnation ordering. |
| Linear/Jira/GitHub/GitLab service methods | roughly 19,329–20,640 and 32,697–35,087 | Many methods contain no textual `this`, but they are network/write/retry adapters. “No `this`” is not purity; duplicate suppression and refetch ordering are behavior. Defer the entire workflows, including the tempting 33,587–34,840 Linear closed call graph. |
| Agent-status/foreground title projection methods | 9,578–10,451; 30,865–31,178 | Mutate explicit PTY/leaf records and depend on observation clocks/ordering, hooks, title trackers, and delivery. Do not move `renewMobileAgentStatusFromPtyTitle` merely because it has no `this`. |
| Type blocks coupled to live records | `RuntimeLeafRecord` 1,263–1,296; `RuntimePtyWorktreeRecord` 1,305–1,358; waiter/layout queue types | Moving these alone creates ownership ambiguity and back-imports. Use narrow structural types in pure modules; leave the state-owner records here. |

## Mechanical implementation gate

1. Extract rows in listed order. Use cut/paste; keep comments and statement order.
2. `orca-runtime.ts` keeps its current public API via direct imports/re-exports. Existing tests should not need mass import rewrites.
3. New characterization tests are needed only for a listed pure function lacking direct coverage; assert current quirks, not preferred behavior.
4. Stop a peel on any circular runtime import, added state/context object, changed public signature, reordered Map/Set iteration, or need to expose a service field. Leaving a row unpeeled is preferable.
5. After each domain module: focused runtime tests and node typecheck. Final gate: runtime tests, `typecheck:node`, and max-lines ratchet.

