# Browser loading surface verification

Latest main (`264c9ed8d27b6ff50d0e38e9c1dd2540539c7bd4`, fetched/rebased before editing) reproduces the dark-mode white flash. The local browser guest factory painted its own host white, even before Electron had supplied a frame. Merely changing that CSS to the theme is insufficient: Electron defaults guest transparency to true, so an unstyled webpage becomes black text on Orca's dark canvas.

The fix stays in `host-guest/browser-page-webview.ts`: use `var(--background)` for the host and Electron's documented `transparent=false` preference for the webpage canvas. Keep the native synthetic blank document unavailable while New Tab owns the pane, and hide unavailable guest pixels after renderer loss until a document commits. Element-owned handlers survive parking and are collected with the guest. They do not duplicate loading state, add timers, change guest DOM/CSS, or cover retained webpages.

## Visible proof

These are uncropped screenshots of the real isolated Orca dev app, attached with Playwright CDP on port 9334 (renderer 5174), with a separate temporary user-data profile.

| State                                                                  | Proof                                                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Latest-main first response held, dark theme                            | [Before](https://github.com/user-attachments/assets/5081d07c-2c8a-4625-a075-0a5c54eae459)       |
| Candidate, same held-response oracle                                   | [After](https://github.com/user-attachments/assets/f300f827-206b-41fc-832d-1eb67182d19d)        |
| Candidate after releasing unstyled HTML; native white canvas preserved | [Page painted](https://github.com/user-attachments/assets/89cc2f04-33d9-4628-ba7b-b1588cfe16ed) |
| Candidate synthetic blank page                                         | [New Tab](https://github.com/user-attachments/assets/106ab2ec-aa6c-44e8-a257-e62474e8a857)      |
| Candidate crashed guest, recovery response held                        | [Recovery](https://github.com/user-attachments/assets/f0a8c890-7fbd-4572-824e-8b3cfe3de9f5)     |

New Tab has existing decorative foreground and address suggestions can be fading after Escape. The oracle samples unobscured surface points, with the same two-channel tolerance in every version; it does not mistake text, menus, or New Tab decoration for background. The initial markup discovery popover is dismissed through its real button and awaited before pre-attach capture.

## Deterministic oracle

`tests/e2e/browser-loading-surface.spec.ts` uses the normal isolated Electron fixture. Its reusable oracle temporarily gates the native `src` attribute to expose the pre-attach phase, then holds a local HTTP response explicitly. It also flushes headers plus a title and empty HTML comment while withholding body content, proving that a committed but not yet painted document still exposes the theme. There are no load-duration sleeps.

The same oracle was run on main, candidate, and candidate with the production change reverted. Each run records full-app PNGs plus two independent signals: raster RGB samples and host/guest state (computed theme/background, attachment, visibility, URL, and loading). A guest DOM read additionally verifies unstyled content and absence of an authored body style. [Matrix](matrix.json), [baseline state](baseline-observations.json), [candidate state](candidate-observations.json), and [reverted state](reverted-observations.json) retain the evidence.

| Phase                                      | Main      | Candidate | Reverted  |
| ------------------------------------------ | --------- | --------- | --------- |
| Pre-attach                                 | Fail      | Pass      | Fail      |
| Dark first response held                   | Fail      | Pass      | Fail      |
| Live light change while held               | Pass      | Pass      | Pass      |
| Live dark change while held                | Fail      | Pass      | Fail      |
| System light while held                    | Pass      | Pass      | Pass      |
| System dark while held                     | Fail      | Pass      | Fail      |
| Committed empty HTML, body withheld        | Fail      | Pass      | Fail      |
| Unstyled webpage painted                   | Pass      | Pass      | Pass      |
| Unstyled webpage after light change        | Pass      | Pass      | Pass      |
| Ordinary reload retains content            | Pass      | Pass      | Pass      |
| Park/unpark retains guest identity/content | Pass      | Pass      | Pass      |
| Crashed guest, recovery response held      | Fail      | Pass      | Fail      |
| Recovery painted                           | Pass      | Pass      | Pass      |
| New Tab                                    | Fail      | Pass      | Fail      |
| First URL from New Tab held                | Fail      | Pass      | Fail      |
| First URL from New Tab painted             | Pass      | Pass      | Pass      |
| Network error surface                      | Pass      | Pass      | Pass      |
| Network retry response held                | Pass      | Pass      | Pass      |
| Network retry painted                      | Pass      | Pass      | Pass      |
| **Total**                                  | **11/19** | **19/19** | **11/19** |

## Boundary and scope

The existing viewport already uses `bg-background`; changing that ancestor cannot fix the white child. A shared loading abstraction or theme synchronization service would add ownership and lifecycle work without fixing another demonstrated failure. The small factory correction uses the existing document theme mechanism directly, so light, dark, and system changes update the host without a subscription or IPC.

Client-hosted retained webviews use a separate factory with no white host assignment. The remote screenshot viewport already uses `bg-background` before a frame, and publishes a frame URL only after image decode. Its `bg-white` image is only mounted with a decoded frame; it is not a pre-frame surface. Both paths were traced and left unchanged. Focused remote component tests protect the no-frame theme and ensure a retained frame has no opening spinner covering it. No remote protocol, host execution, provider, workspace-path, or Git behavior changes.

No additional spinner was added. The existing toolbar reports loading, and the remote no-frame path already reports opening. A new central indicator would require more state to distinguish retained usable content. No focus, announcements, or keyboard shortcuts were added.

## Tests / verification

- Setup: `orca.yaml` setup (`node config/scripts/run-internal-dev-setup.mjs`, `pnpm install`), plus Electron native runtime setup; `git fetch origin main` and `git rebase origin/main` before implementation.
- `pnpm tc:web`: passed.
- Focused Vitest files: 8 tests passed (webview input lock/surface, reuse/remount initialization, blank/recovery ownership, remote viewport).
- `pnpm run test:e2e -- tests/e2e/browser-loading-surface.spec.ts tests/e2e/browser-reload-feedback.spec.ts tests/e2e/browser-guest-crash-recovery.spec.ts --workers=1`: the six existing reload/recovery tests passed; the new oracle initially exposed sampling/setup issues. After correcting those, `SKIP_BUILD=1 pnpm run test:e2e -- tests/e2e/browser-loading-surface.spec.ts --workers=1` passed (17.2 seconds).
- Changed-file oxlint and the changed-code quality gate: passed after archiving temporary exploratory scripts outside the tracked source tree.
- Optional whole-suite `pnpm run typecheck:e2e` reports unrelated suite diagnostics, including `activity-agent-pane-isolation.spec.ts` and `browser-tab.spec.ts`; no diagnostic names either added oracle file. This broader check is not green.
- Full dev matrix: candidate 19/19; baseline and reverted candidate fail the same eight phases. The candidate production file was restored afterward.
- Raw run logs and additional screenshots are local at `test-results/browser-themed-loading/dev-proof/` (ignored, not committed). The curated screenshots above are GitHub attachments; the report and state evidence are committed.

Native rendered testing was on macOS with Electron 43. Linux/Windows, a live paired host, and an SSH/folder workspace were not separately exercised. Their execution paths and wire contracts are unchanged; the oracle uses portable fixture APIs and is suitable for those CI runners. Guest replacement on container remount has focused state coverage; the real rendered matrix exercises retained park/unpark and renderer recovery.

## Review until clean

### High-Level Summary

Three fresh independent Codex reviewers checked architecture/simplicity, visual/theme/accessibility, and lifecycle/regression risk. Two review rounds completed; the production change needed no follow-up branches or special cases.

### Issues Fixed

- Medium validation gap: added controlled network failure/retry and committed-empty HTML coverage.
- Validation sampling: dismissed transient discovery UI, waited for its disappearance, and sampled the unobscured surface instead of New Tab foreground/address suggestions.

### Remaining Issues by Severity

No proven in-scope review issues remain. The platform and broader typecheck limits above remain explicit.

### Tests / Verification

All three final reviews accepted the 19/19 candidate result and identical baseline/revert failures. Elegance review favors the existing guest factory; performance review found only bounded element-owned event handlers, with no polling, timers, store subscriptions, extra IPC, or persistent external resources.

### Future PR Suggestions

None.

## Recommendation and mutation state

Ready for code review, with cross-platform CI recommended before merge. Branch: `sep04-browser-themed-loading`. Local validation completed before the user authorized publishing the branch and creating a PR. Screenshots were then uploaded as GitHub attachments for review. No merge, deployment, or Linear/Slack mutation was performed. Orca worktree checkpoint comments record the task status. Isolated dev and fixture processes started for this task were stopped.
