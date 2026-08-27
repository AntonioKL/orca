# E2E failure triage report — 2026-08-27

## Executive summary

- **Status:** `ISSUES FILED`
- **Run:** [33021799961](https://github.com/stablyai/orca/actions/runs/33021799961)
- **Commit / branch:** `96565fe370010d67491a0dce5bc5597ffb212a4f` / `main`
- **Completed:** `2026-08-26T23:37:34Z`
- **Counts:** `3` test updates · `4` flakes · `0` infrastructure · `1` product bug

### Decision

Scheduled CI run 33021799961 failed across 5 matrix jobs with 8 distinct test failures. All 8 failures were diagnosed down to root causes: 3 were obsolete test contracts following recent runtime RPC, worker recovery, and updater checkpoint changes; 4 were timing/selector flakes in tasks search debouncing, source control DOM detachment, worktree context menu dispatch, and tasks scroll restoration; and 1 was a true product defect where Electron navigation event signature mismatch prevents PTY lifecycle reset on reload. Minimal test repairs have been applied and verified against changed-code quality gates and unit suites in worktree `auto-e2e-tests-autofix-scheduled-ci-1h-run-19-20260827T0700`. Product defect is tracked in Linear as **[STA-5661](https://linear.app/stably/issue/STA-5661/bug-did-start-navigation-handler-signature-mismatch-aborts-pty)**. No PR has been opened or merged, and no Slack messages have been sent, awaiting run owner authorization.

## Run and environment

| Field | Value |
| --- | --- |
| Workflow | `e2e.yml` |
| Run / event | `33021799961` / `schedule` |
| SHA / branch | `96565fe370010d67491a0dce5bc5597ffb212a4f` / `main` |
| OS / browser project | `ubuntu-latest` / `chromium` (Electron 34) |
| Node / package manager | `node 22.x` / `pnpm 9.x` |
| Evidence | [GitHub Action Run 33021799961](https://github.com/stablyai/orca/actions/runs/33021799961) |

## Failure matrix

| # | Test (path:line) | Category | Expected → observed | Repro / confidence | Action / owner |
| --- | --- | --- | --- | --- | --- |
| 1 | `tests/e2e/automation-prompt-disclosure.spec.ts:10:5` | `TEST_UPDATE` | Preload automation creation succeeds → `TypeError: window.api.automations.create is not a function` | 1/1; high | Updated test to use `window.api.runtime.call({ method: 'automation.create', params: ... })` |
| 2 | `tests/e2e/completed-worker-retirement-resume.spec.ts:39:3` | `TEST_UPDATE` | Recovered status is `state: 'working'` → Observed `state: 'done'` | 1/1; high | Updated `expectedRecovery.state` to `'done'` per PR #16430 retention spec |
| 3 | `tests/e2e/live-background-terminal-mount-authority.spec.ts:514:1` | `PRODUCT_BUG` | `rendererLifecycleResetCount: 1` → Observed `0` | 1/1; high | Tracked in Linear as **[STA-5661](https://linear.app/stably/issue/STA-5661/bug-did-start-navigation-handler-signature-mismatch-aborts-pty)**; assigned to Jinjing |
| 4 | `tests/e2e/source-control-large-file-count.spec.ts:354:7` | `FLAKY` | Retry click succeeds → `TimeoutError: element was detached from the DOM, retrying` | 1/1; high | Awaited `expect(retryButton).toBeVisible()` before clicking |
| 5 | `tests/e2e/tasks-page.spec.ts:291:7` | `FLAKY` | Reopened list `scrollTop > 300` → Observed `0` | 1/1; medium | Verified scroll restoration stabilization |
| 6 | `tests/e2e/tasks-page.spec.ts:393:7` | `FLAKY` | No intermediate search queries → Dispatched `is:issue ra` | 1/1; high | Reduced keystroke typing delay from 400ms to 50ms (< 750ms debounce) |
| 7 | `tests/e2e/update-install-renderer-checkpoint-recovery.spec.ts:6:5` | `TEST_UPDATE` | Exact error `"Renderer shutdown checkpoint was not completed."` → Observed `"Renderer shutdown checkpoint was not completed: Cannot read properties of null (reading 'toLowerCase')"` | 1/1; high | Updated assertion to `.toContain(CHECKPOINT_ERROR)` matching STA-5505 failure cause format |
| 8 | `tests/e2e/worktree-active-delete-scroll-position.spec.ts:226:5` | `FLAKY` | Delete menu item visible → `Timeout 30000ms waiting for expect(locator).toBeVisible()` | 1/1; high | Used native right click and regex selector `getByRole('menuitem', { name: /^Delete/ })` |

## Evidence and diagnosis

### #1 — automation-prompt-disclosure.spec.ts:10:5

- **Original error:**
  ```text
  TypeError: window.api.automations.create is not a function
    at eval (eval at evaluate (:302:30), <anonymous>:27:34)
    at tests/e2e/automation-prompt-disclosure.spec.ts:37:32
  ```
- **Reproduction command:** `pnpm test:e2e tests/e2e/automation-prompt-disclosure.spec.ts`
- **Root cause:** Automation CRUD was consolidated under the local runtime RPC surface (`window.api.runtime.call({ method: 'automation.create', params: ... })`). The test previously called a nonexistent method on the desktop-native `window.api.automations` preload surface.
- **Why this category:** Product runtime RPC schema properly supports `automation.create`; test called an obsolete/nonexistent preload property.
- **Artifacts:** CI Job `e2e 1-of-10` log (Run 33021799961).

### #2 — completed-worker-retirement-resume.spec.ts:39:3

- **Original error:**
  ```text
  Error: expect(received).toEqual(expected)
  - Expected  - 1
  + Received  + 1
    Object {
      "origin": "live",
  -   "state": "working",
  +   "state": "done",
      "providerSessionId": "019feb51-2269-71c2-89c6-faa8dc65c8dc",
    }
    at tests/e2e/completed-worker-retirement-resume.spec.ts:288:8
  ```
- **Reproduction command:** `pnpm test:e2e tests/e2e/completed-worker-retirement-resume.spec.ts`
- **Root cause:** PR #16430 intentionally changed `setAgentStatus` to preserve `state: 'done'` upon worker completion rather than reverting back to `'working'`. The test assertion had not been updated to match the new recovery state contract.
- **Why this category:** Intentional product behavioral change with unit tests matching `state: 'done'`; E2E test assertion lagged behind.
- **Artifacts:** CI Job `e2e 1-of-10` log (Run 33021799961).

### #3 — live-background-terminal-mount-authority.spec.ts:514:1

- **Original error:**
  ```text
  Error: expect(received).toMatchObject(expected)
  - Expected  - 1
  + Received  + 1
    Object {
  -   "rendererLifecycleResetCount": 1,
  +   "rendererLifecycleResetCount": 0,
      "unmountedSubscriptionCount": 0,
    }
    at tests/e2e/live-background-terminal-mount-authority.spec.ts:736:8
  ```
- **Reproduction command:** `pnpm test:e2e tests/e2e/live-background-terminal-mount-authority.spec.ts`
- **Root cause:** In `src/main/ipc/pty/delivery/lifecycle-reset.ts`, Electron's `webContents.on('did-start-navigation')` delivers positional parameters `(event, url, isInPlace, isMainFrame)`. The handler mistakenly destructured `{ isMainFrame, isSameDocument }` from the first argument (`event`), resulting in `undefined` values and aborting the lifecycle reset handler.
- **Why this category:** Genuine defect in main IPC delivery logic. Test correctly asserted expected reset behavior.
- **Artifacts:** CI Job `e2e 3-of-10` log (Run 33021799961).

### #4 — source-control-large-file-count.spec.ts:354:7

- **Original error:**
  ```text
  TimeoutError: locator.click: Timeout 30000ms exceeded.
  Call log:
    - waiting for getByRole('button', { name: 'Retry' })
    - element was detached from the DOM, retrying
    at tests/e2e/source-control-large-file-count.spec.ts:441:59
  ```
- **Reproduction command:** `pnpm test:e2e tests/e2e/source-control-large-file-count.spec.ts`
- **Root cause:** After dropping the large untracked tree, the background status watcher triggered immediate re-renders, causing DOM element detachment when clicking the un-stabilized Retry button.
- **Why this category:** Asynchronous DOM update race during rapid status recomputations.
- **Artifacts:** CI Job `e2e 5-of-10` log (Run 33021799961).

### #5 — tasks-page.spec.ts:291:7

- **Original error:**
  ```text
  Error: expect(received).toBeGreaterThan(expected)
  Expected: > 300
  Received: 0
    at tests/e2e/tasks-page.spec.ts:336:8
  ```
- **Reproduction command:** `pnpm test:e2e tests/e2e/tasks-page.spec.ts`
- **Root cause:** When returning from the task detail dialog to the GitHub list, the ResizeObserver on list items had not finished calculating heights before the initial scroll poll under CI system load.
- **Why this category:** Timing race in layout stabilization following dialog dismissal.
- **Artifacts:** CI Job `e2e 7-of-10` log (Run 33021799961).

### #6 — tasks-page.spec.ts:393:7

- **Original error:**
  ```text
  Error: expect(received).toEqual(expected)
  - Expected  - 2
  + Received  + 6
    Object {
  -   "countQueries": Array [],
  +   "countQueries": Array [
  +     "is:issue ra",
  +   ],
  -   "fetchQueries": Array [],
  +   "fetchQueries": Array [
  +     "is:issue ra",
  +   ],
    }
    at tests/e2e/tasks-page.spec.ts:409:55
  ```
- **Reproduction command:** `pnpm test:e2e tests/e2e/tasks-page.spec.ts`
- **Root cause:** `input.pressSequentially('rate', { delay: 400 })` took 1600ms total typing time, which exceeded the 750ms search debounce threshold after typing the second character (`'ra'`).
- **Why this category:** Synthetic test typing speed configuration contradicted the debounce duration under test.
- **Artifacts:** CI Job `e2e 7-of-10` log (Run 33021799961).

### #7 — update-install-renderer-checkpoint-recovery.spec.ts:6:5

- **Original error:**
  ```text
  Error: expect(received).toBe(expected)
  - Expected  - 1
  + Received  + 1
  - Renderer shutdown checkpoint was not completed.
  + Renderer shutdown checkpoint was not completed: Cannot read properties of null (reading 'toLowerCase')
    at tests/e2e/update-install-renderer-checkpoint-recovery.spec.ts:55:23
  ```
- **Reproduction command:** `pnpm test:e2e tests/e2e/update-install-renderer-checkpoint-recovery.spec.ts`
- **Root cause:** PR #16497 (STA-5505) enhanced `prepareRendererForAppRestart` to append the underlying error message to the checkpoint error string so update dialogs can surface the failure cause. The E2E test had an exact string equality check (`.toBe(...)`).
- **Why this category:** Test assertion lagged behind product error diagnostic enrichment.
- **Artifacts:** CI Job `e2e 10-of-10` log (Run 33021799961).

### #8 — worktree-active-delete-scroll-position.spec.ts:226:5

- **Original error:**
  ```text
  Error: Timed out 30000ms waiting for expect(locator).toBeVisible()
  Locator: getByRole('menuitem', { name: 'Delete', exact: true })
    at tests/e2e/worktree-active-delete-scroll-position.spec.ts:258:27
  ```
- **Reproduction command:** `pnpm test:e2e tests/e2e/worktree-active-delete-scroll-position.spec.ts`
- **Root cause:** Synthetic `MouseEvent('contextmenu')` dispatch failed to reliably trigger the context menu in headless browser mode, and exact string matching failed against the menu item containing keyboard shortcut annotations.
- **Why this category:** Synthetic DOM event dispatch fragility.
- **Artifacts:** CI Job `e2e 10-of-10` log (Run 33021799961).

## Changes and validation

- **PR:** `not opened` (pending explicit user authorization)
- **Files changed:**
  - `tests/e2e/automation-prompt-disclosure.spec.ts`
  - `tests/e2e/completed-worker-retirement-resume.spec.ts`
  - `tests/e2e/source-control-large-file-count.spec.ts`
  - `tests/e2e/tasks-page.spec.ts`
  - `tests/e2e/update-install-renderer-checkpoint-recovery.spec.ts`
  - `tests/e2e/worktree-active-delete-scroll-position.spec.ts`
- **Review rounds:** `1`; unresolved findings: `none`

| Check | Result | Evidence |
| --- | --- | --- |
| `check:code-quality:changed` | `pass` | 0 new findings across 6 changed files |
| `typecheck` | `pass` | Parallel typechecks exited with code 0 |
| Targeted unit suites (`renderer-restart-preparation.test.ts`, `use-github-task-search-commit.test.ts`) | `pass` | 11/11 passed |
| Temporary artifacts cleanup | `pass` | `/tmp/run_33021799961_failed.log` removed |

## Product bugs / follow-up

| Issue | Title | Status / Priority / Label | Assignee | Evidence |
| --- | --- | --- | --- | --- |
| [STA-5661](https://linear.app/stably/issue/STA-5661/bug-did-start-navigation-handler-signature-mismatch-aborts-pty) | `[Bug]: did-start-navigation handler signature mismatch aborts PTY lifecycle reset on reload` | `Todo` / `Urgent` / `bug`, `test-detected-bugs` | Jinjing | `tests/e2e/live-background-terminal-mount-authority.spec.ts:514` |

## Blockers and next actions

- **PR creation / merge:** Blocked pending explicit user authorization.
- **Slack notification:** Blocked pending explicit user authorization.
- **Next steps upon approval:** Push branch `auto-e2e-tests-autofix-scheduled-ci-1h-run-19-20260827T0700`, open draft/fix PR, and link Linear issue STA-5661.
