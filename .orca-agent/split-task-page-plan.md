# TaskPage.tsx split plan

Hard goal: `src/renderer/src/components/TaskPage.tsx` <= 400 lines and every new dest file <= 400 lines. Zero intentional behavior change. Cut/paste + imports. Keep why-comments. No max-lines disables.

## Baseline (Phase A)

- Branch: `split-task-page` @ `cb42b60849`
- Source: 13572 lines, `eslint-disable max-lines` grandfathered in `config/max-lines-baseline.txt`
- Public API: default export only. Consumer: `App.tsx` lazy `import('./components/TaskPage')`
- `pnpm run typecheck:web` green
- Focused tests: 36 files / 320 tests green (`vitest run … TaskPage task-page task-page-`)
- Note: `pnpm test -- src/renderer/src/components/TaskPage` appends the filter to `ensure-native-runtime` because of `&&`; use `pnpm exec vitest run --config config/vitest.config.ts …`

## Inventory

| Region | Lines | ~LOC | Role |
|---|---|---|---|
| Imports | 1–475 | 475 | stay with consumers |
| Standalone helpers/cells | 476–2988 | 2513 | extract first |
| `TaskPage` hooks/state | 2989–8876 | 5888 | custom hooks |
| `TaskPage` JSX | 8877–13572 | 4696 | view components |
| **Total** | | **13572** | |

GHStatusCell 1001–1414 (~414) and PRReviewCell 1982–2559 (~577) exceed 400 and must be internally split.

## Dest root

`src/renderer/src/components/task-page/` with nested domain folders. Existing `task-page-*.ts` at `components/` stay put.

## Cut order

1. Standalone symbols (leaf modules, no TaskPage hook coupling)
2. JSX views (props objects per domain)
3. Hook slices (unconditional custom hooks)
4. Thin `TaskPage.tsx` barrel
5. Remove max-lines disable; `pnpm check:max-lines-ratchet --prune`

---

## 1. Standalone dest files

| Dest | Source lines | Symbols |
|---|---|---|
| `gitlab/gitlab-task-filters.ts` | 476–484 | `isGitLabMRFilter`, `isGitLabIssueFilter` |
| `task-page-list-limits.ts` | 486–489 | `TASK_SEARCH_DEBOUNCE_MS`, `LINEAR_ITEM_LIMIT`, `JIRA_ITEM_LIMIT`, `PR_CHECKS_EAGER_PREFETCH_LIMIT` |
| `github/github-task-surface-classes.ts` | 491–499, 618–637 | grid/row/header/sticky class constants |
| `workspace-seeds.ts` | 501–526 | `getGitHubWorkItemWorkspaceSeed`, `getGitLabWorkItemWorkspaceSeed`, `getJiraIssueWorkspaceSeed` |
| `source/repo-source-context.ts` | 528–616 | `getTaskPageRepoSourceContext`, `buildGitLabProviderIdentity`, `getTaskPageRepoCacheInput` |
| `source/task-source-host-availability.ts` | 571–600 | `getTaskSourceHostAvailabilityForHost` |
| `relative-time.ts` | 639–641 | `formatRelativeTime` |
| `linear/linear-issue-grouping.ts` | 643–683, 845–916, 963–983 | types + merge/compare/group + grid template + `LINEAR_CUSTOM_VIEW_MODELS` |
| `linear/linear-state-cell.tsx` | 685–844 | `LinearStateCell` |
| `jira/jira-error-banner.tsx` | 918–961 | `TaskPageJiraErrorBanner` |
| `github/github-work-item-mutation-runner.ts` | 985–999 | `TaskPageGitHubWorkItemMutationRunner` |
| `github/github-status-duplicate-picker.tsx` | 1262–1352 + handlers | duplicate-picker subtree of GHStatusCell |
| `github/github-status-cell.tsx` | 1001–1414 minus picker | `GHStatusCell` |
| `github/github-assignee-avatars.tsx` | 1416–1461 | `ReviewChipAvatar`, `GitHubAssigneeAvatar` |
| `github/github-issue-label-selector.tsx` | 1463–1555 | `GitHubIssueLabelSelector` |
| `github/github-issue-assignee-selector.tsx` | 1557–1664 | `GitHubIssueAssigneeSelector` |
| `github/github-assignees-cell.tsx` | 1666–1921 | `GHAssigneesCell` |
| `github/github-reviewer-suggestions.ts` | 1923–1980 | `sameOptionalGitHubOwnerRepo`, `resolveTaskPullRequestRepo`, `mergeReviewerSuggestions`, `buildRequestedReviewUsers` |
| `github/pr-review-picker.tsx` | ~2418–2559 | picker popover body of `PRReviewCell` |
| `github/pr-review-cell.tsx` | 1982–2417 | `PRReviewCell` shell |
| `github/pr-checks-cell.tsx` | 2561–2639 | `PRChecksCell` |
| `github/pr-merge-cell.tsx` | 2641–2861 | `PRMergeCell` |
| `pagination/pagination-bar.tsx` | 2863–2944 | `PaginationBar` |
| `source/repo-source-divergence.ts` | 2945–2960 | `hasDivergentSources`, `hasUpstreamCandidateDivergence` |
| `dialogs/task-creation-draft-writers.ts` | 2962–2987 | `writeNewLinearProjectDraft`, `writeNewLinearIssueDraft`, `writeNewJiraIssueDraft` |

Characterization tests (uncovered pure symbols only):

- `gitlab/gitlab-task-filters.test.ts`
- `source/repo-source-context.test.ts` (`buildGitLabProviderIdentity`, cache input)
- `source/task-source-host-availability.test.ts`
- `linear/linear-issue-grouping.test.ts`
- `github/github-reviewer-suggestions.test.ts`
- `source/repo-source-divergence.test.ts`

---

## 2. Hook slices (`task-page/hooks/`)

Rules of hooks: each `use*` is called unconditionally from `useTaskPageModel` / `TaskPage`. No dest file > 400.

| Dest | Approx source | Owns |
|---|---|---|
| `use-task-page-store-bindings.ts` | 2989–3064 | `useAppStore` / selector bindings |
| `use-task-page-repo-selection.ts` | 3064–3157 | eligible repos, selection prune, `selectedReposKey`, primary repo, linear/jira workspace/site |
| `use-task-page-visible-sources.ts` | 3158–3220 | visible providers, `hideTaskSource`, option lists |
| `use-task-page-runtime-preflight.ts` | 3227–3346 | runtime preflight map + RPC |
| `use-task-page-source-availability.ts` | 3347–3597 | host registry, Linear/Jira source contexts, availability notices |
| `use-task-page-source-sync.ts` | 3598–3636 | taskSource state + sidebar/default sync effects |
| `use-task-page-gitlab-list-state.ts` | 3641–3686 | GitLab view/filter/items/todos state |
| `use-task-page-github-list-state.ts` | 3687–3771 | search/pages/pagination state + resume key |
| `use-task-page-github-list-resume.ts` | 3773–3928 | resume cache, scroll restore, generation bump |
| `use-task-page-detail-openers.ts` | 3937–4051 | dialog item, GH/GL detail openers, row patch |
| `use-task-page-github-source-banners.ts` | 4053–4131 | per-repo source state, retry, refresh |
| `use-task-page-github-new-issue-state.ts` | 4132–4230 | new GitHub issue dialog state |
| `use-task-page-selected-issue-state.ts` | 4232–4403 | selected Linear/Jira issue + float |
| `use-task-page-linear-list-state.ts` | 4404–4600 | Linear mode/issues/filters/view prefs |
| `use-task-page-linear-project-view-state.ts` | 4441–4700 | projects, custom views, project tab |
| `use-task-page-linear-derived.ts` | 5000–5566 | grouping, board drag, page change |
| `use-task-page-jira-list-state.ts` | 5600–6160 | Jira issues/sort/create fields |
| `use-task-page-create-dialog-state.ts` | 5740–6100 | Linear/Jira create dialog state |
| `use-task-page-github-fetch.ts` | 6417–7228 | page load + list fetch effect |
| `use-task-page-github-search.ts` | 7229–7440 | search/preset/kind handlers + use-item |
| `use-task-page-create-submits.ts` | 7449–7900 | create GH/Linear/Jira submits |
| `use-task-page-linear-fetch.ts` | 8029–8560 | Linear list/project/view fetch effects |
| `use-task-page-linear-actions.ts` | 8562–8858 | Linear open/workspace/team handlers |
| `use-task-page-jira-actions.ts` | 8859–8876 + jira fetch | Jira use/open + fetch effect |
| `use-task-page-model.ts` | composition | calls the above, returns one model object |

Exact line splits may shift after earlier cuts; implementer keeps each dest <= 400 by splitting a hook again rather than leaving an oversized file.

---

## 3. JSX views

| Dest | Source | Content |
|---|---|---|
| `chrome/task-page-source-toolbar.tsx` | 8877–9076 | close, source icons, Linear/Jira scope |
| `chrome/task-page-github-filters.tsx` | 9078–9415 | repo picker, GH kind/preset/search |
| `chrome/task-page-linear-filters.tsx` | 9416–9700 | Linear mode/view/search |
| `chrome/task-page-jira-filters.tsx` | 9701–9850 | Jira preset/search/sort |
| `chrome/task-page-gitlab-filters.tsx` | 9851–9997 | GitLab view/filter |
| `github/github-detail-host.tsx` | 9998–10032 | PR page / issue dialog / project wrapper |
| `github/github-work-item-table.tsx` | 10034–10350 | header + empty/error |
| `github/github-work-item-rows.tsx` | 10350–10661 | rows + pagination |
| `gitlab/gitlab-todos-list.tsx` | 10662–10752 | todos |
| `gitlab/gitlab-work-item-list.tsx` | 10753–10878 | MR/issue rows |
| `jira/jira-issue-list-host.tsx` | 10879–10992 | Jira list + workspace |
| `linear/linear-connect-empty.tsx` | 11003–11027 | connect Linear empty |
| `linear/linear-project-overview-host.tsx` | 11028–11074 | project overview |
| `linear/linear-project-table-host.tsx` | 11075–11152 | project table |
| `linear/linear-custom-view-host.tsx` | 11153–11230 | custom view projects |
| `linear/linear-issue-toolbar.tsx` | 11231–11373 | issue list chrome |
| `linear/linear-issue-ungrouped-list.tsx` | 11374–11548 | ungrouped list |
| `linear/linear-issue-board.tsx` | 11549–12004 | board |
| `linear/linear-issue-grouped-list.tsx` | 12005–12075 | grouped list / project issues |
| `dialogs/new-github-issue-dialog.tsx` | 12076–12259 | new GH issue |
| `dialogs/new-linear-project-dialog.tsx` | 12260–12650 | new Linear project (split if >400) |
| `dialogs/new-linear-issue-dialog.tsx` | ~12650–12950 | new Linear issue (split if >400) |
| `dialogs/new-jira-issue-dialog.tsx` | ~12950–13546 | new Jira issue (split if >400) |
| `task-page-layout.tsx` | composition | outer shell + branch on `taskSource` |

Dialogs at the tail (GitLabItemDialog, LinearApiKeyDialog, JiraConnectDialog) stay in layout (~30 lines).

Views take a typed props object (or the model slice). No god context unless a single subtree still needs 80+ unique locals after slice extraction.

---

## 4. Final `TaskPage.tsx` (<= 400)

```tsx
import TaskPage from './task-page/task-page-root'
export default TaskPage
```

`task-page/task-page-root.tsx` calls `useTaskPageModel()` and renders `TaskPageLayout`. Both stay <= 400.

Remove line-1 `eslint-disable max-lines`. Prune baseline.

## Circular imports

- Leaf modules never import `TaskPage` or `task-page-root`.
- Hooks import leaves; views import leaves + receive model slices as props.
- Types that both hooks and views need live in `task-page/task-page-model-types.ts` (or colocated with the leaf).
- Do not import from `task-page-root` into dest files.

## Verification

```bash
pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/TaskPage src/renderer/src/components/task-page src/renderer/src/components/task-page-
pnpm run typecheck:web
pnpm run check:max-lines-ratchet
wc -l src/renderer/src/components/TaskPage.tsx src/renderer/src/components/task-page/**/*.{ts,tsx}
```

Every printed dest must be <= 400. Source must be <= 400.

## Commit

If green: `refactor: split TaskPage.tsx under 400 lines`
No push / no PR / no parent worktree edits.
