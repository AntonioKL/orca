# Lane 1 — Worktree-create flow: sheet never returns + slow picker

Branch: `brennanb2025/mob-create-flow-perf` (off `origin/main` @ `fecdf0bde8`)
Worktree: `/Users/brennanbenson/orca/workspaces/orca/mob-create-flow-perf`
Simulator used: **iPhone 17 Pro Max** (`CCA8A76F-77D1-4461-8318-63C7ED69D28E`) only.

---

## What was wrong, in one sentence each

**Bug A — the form sheet never comes back after a source is picked.**
`BottomDrawerModalHost` keeps a single full-screen native `Modal` mounted for the whole create
flow, and `resolveNewWorktreeFormSheetVisible` rendered **no sheet at all** during the
`transition` state unless a render-read ref happened to say the form was pinned — so any beat
where the drawer swap does not complete leaves a transparent, tap-swallowing window with nothing
in it, and there was no recovery path of any kind; on device the failure lands one step further
in, where the create form's `MountedBottomDrawer` is left pinned at `progress = 1` and nothing
ever re-applies its enter transform when the fill picker hands the window back, so the sheet is
laid out but never painted.

**Bug B — the picked source is lost.**
`NewWorktreeModal` bumped its remount key on the **identity of the `RpcClient` object**
(`clientEpochRef`), and `useHostClient` swaps that object for the *same host* on every reconnect,
`forceReconnect`, and foreground revival — so an ordinary network blip silently remounted the
live form and threw the user's picked PR away, with no user action involved.

**Bug C — the picker is slow.**
`runSmartSearch` in `use-smart-workspace-source.ts` `await`ed the provider fan-out and *then*
`await`ed the pasted-item lookup, stacking two full host round trips on the single most common
path (typing a PR number). Measured on device: **2631 ms → 1480 ms** for the same query.

---

## Evidence

### 1. Frame forensics on the supplied recording

`recording.mov`, re-extracted with **output seeking** (`ffmpeg -i FILE -ss N -to M`) at 20 fps and
measured with `signalstats` luma over fixed crops. All numbers are mean luma of the same pixel
band, so they are directly comparable:

| t (s) | header band | sheet band | state |
|---|---|---|---|
| 6.95 | 22.88 | 45.17 | source picker open over the pinned form |
| 7.00 | 23.64 | 49.39 | selection applied |
| **7.05** | **29.60** | 32.98 | **no backdrop, no sheet** — bare list, host `Modal` still mounted |
| **7.10** | **29.62** | 31.65 | same |
| **7.15 → 25.0** | **17.36** | 18.11 | **full-opacity backdrop, no sheet** — 18.3 s of dead screen |
| 25.5 → 30.0 | 29.69 | — | modal fully closed (a tap finally landed on the backdrop) |
| 31.0 | 17.36 | — | modal reopened, **Name field empty** |

Two things fall straight out of that table:

* 7.05–7.10 is the `transition` beat with nothing rendered — 29.6 is exactly the undimmed value,
  i.e. **no drawer at all**, while the host `Modal` is still mounted and eating taps.
* From 7.15 the dim is **17.36**, byte-identical to 17.36 at t=31.0 when the form sheet is
  legitimately open. Same backdrop, same opacity — but a band-by-band ratio sweep of the whole
  frame (dead vs. undimmed, every 100 px from y=0 to y=1500) returns a flat **0.52–0.61**
  everywhere including the very bottom. There is no sheet anywhere on screen. Crop of the bottom
  280 px is in `lane1-evidence/06-user-video-dead-frame-bottom-crop.png`.

So the 18 s is not a slow transition and not an async wait: the modal reached a state where the
backdrop paints and the sheet does not, and **nothing in the code can get out of it**. It ended
only because one of the user's taps hit the backdrop, and the form sheet's backdrop `dismiss()`
closes the *whole* modal — which is why the sheet came back empty at t=31 s. **Bug B as seen in
the video is a consequence of Bug A**; Bug B also has its own independent cause (below).

### 2. Live reproduction on the simulator

Rig: isolated dev host from this worktree
(`ORCA_DEV_USER_DATA_PATH=/tmp/lane1-orca-userdata ORCA_DEV_INSTANCE_KEY=lane1 pnpm dev`, proven
isolated with `repos.list() → []`), one repo added, LAN pairing deep link, Metro started with
`./node_modules/.bin/expo start --host lan --port 8091` (never bare `pnpm`), all UI interaction
through `orca emulator tap` / `type` on iPhone 17 Pro Max.

Sequence: `+` FAB → Create worktree → tap the source field → tap a GitHub PR row.

* `lane1-evidence/01-source-picker-open.png` — picker open with real PRs.
* `lane1-evidence/02-REPRO-dead-screen-after-pr-select.png` — **reproduced**: dimmed screen, no
  sheet. It stayed that way for **77 s** of polling (not 18 s — it is permanent until the user
  taps the backdrop).

Instrumenting `MountedBottomDrawer` with `onLayout` and a worklet log then proved the sheet is
*there* and correctly positioned:

```
[DBG] drawer layout z=1000 {"x":0,"y":464.67,"width":440,"height":491.33}
[DBG] worklet    z=1000 p=1 ty=0 kb=0 sh=956
```

`progress = 1`, `translateY = 0`, layout `y=464.67, h=491.33` on a 956 pt screen — a perfectly
placed, on-screen sheet that is not painted. Temporarily tinting `styles.drawer` red made the
whole sheet appear **still holding the picked PR** —
`lane1-evidence/03-tinted-proof-sheet-laid-out-but-unpainted.png`. Any re-render restored it.

That is the fingerprint of a stale native transform on a view that was rebuilt underneath
Reanimated: the pinned sheet holds `progress` at 1 for the entire time the fill picker owns the
window, so when the picker leaves, **nothing re-applies the enter transform**. On the runs where
the native view survived intact it looks fine; on the runs where it did not, the sheet is gone
for good. The reproduction is intermittent — 1 in ~12 attempts on this rig with a one-repo host;
the user hit it on the first try on a host with hundreds of worktrees.

### 3. Timeline / drawer-state trace at the moment of the swap

From the instrumented run (`z=1000` is the form sheet, `z=1100` the fill picker):

```
transitionDrawer -> form pinned= true
nav render drawerView= transition pinned= true
drawer render visible= true  interactive= false z=1000   <- form pinned, backdrop opacity 0
drawer render visible= false interactive= true  z=1100   <- picker leaving
transition TIMER fired -> form
nav render drawerView= form pinned= false
drawer render visible= true  interactive= true  z=1000   <- form takes the window back
```

Note the last line: `interactive` flips `false → true` and **no effect re-runs** — `visible` never
changed, so `MountedBottomDrawer`'s only enter-animation effect (deps `[onHidden, visible]`) does
not fire. That is the hand-back with nothing re-asserted.

---

## Fixes

### A1 — `mobile/src/components/mounted-bottom-drawer.tsx`

Re-assert the enter transform whenever a *visible* sheet takes the window back from a pinned
state (`interactive` false → true). This is the exact transition the trace above shows going
unhandled, and it makes the sheet self-heal instead of staying invisible forever.

### A2 — `mobile/src/components/new-worktree-form-sheet-visibility.ts` + `use-new-worktree-drawer-navigation.ts`

The create form is now the modal's floor: it stays mounted and visible through **every**
`transition`, not only the source-picker one. This deletes the "mounted host `Modal`, zero
sheets" state entirely, so a dropped or delayed transition timer degrades to "the picker did not
open" rather than "the app is dead". As a direct consequence the `formPinnedUnderSourceRef` —
a ref *read during render*, i.e. state that can go stale without scheduling a render — is no
longer needed and is deleted. The hook is 12 lines shorter.

### B — `mobile/src/components/NewWorktreeModal.tsx`

The form session is keyed on `hostId`, never on the `RpcClient` object. Every client-scoped hook
under the modal (`useNewWorkspaceRepositories`, `useSmartWorkspaceSource`, `useMobileComposerSource`
via `resolveTokenRef`, …) already drops responses from a superseded client, so the remount bought
nothing and cost the user their form. Switching hosts still starts a fresh session — and now
actually does, which it did **not** before: pre-fix, changing `hostId` while the client object
stayed the same (e.g. both `null`) left the previous host's form state in place.

### C — `mobile/src/tasks/use-smart-workspace-source.ts`

The pasted-item lookup and the provider fan-out hit different host endpoints and are now issued
together with `Promise.all` instead of one after the other. The paste branch is extracted into
`resolvePastedItem` so `runSmartSearch` stays readable.

---

## Regression tests — each one fails against the unfixed code

All runs below are `cd mobile && npx vitest run <path>` with the fix reverted, then restored.

### A2 — `mobile/src/components/use-new-worktree-drawer-navigation.test.ts`

```
 FAIL  src/components/use-new-worktree-drawer-navigation.test.ts > useNewWorktreeDrawerNavigation
       > keeps a sheet on screen while swapping to a content-sized picker
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false
      Tests  1 failed | 2 passed (3)
```

(The companion `new-worktree-form-sheet-visibility.test.ts` case
`never leaves the mounted modal without a sheet during a drawer swap` also fails pre-fix —
`expected undefined to be true`.)

### A1 — `mobile/src/components/bottom-drawer-window-handback.test.ts`

```
 FAIL  src/components/bottom-drawer-window-handback.test.ts > bottom drawer window hand-back
       > re-asserts the enter transform when a pinned sheet takes the window back
AssertionError: expected 1 to be 2 // Object.is equality

- Expected
+ Received

- 2
+ 1
      Tests  1 failed | 1 passed (2)
```

The second case in that file (`does not re-assert while the sheet stays pinned`) passes both
before and after on purpose — it is the guard that keeps the fix from firing on every render.

### B — `mobile/src/components/NewWorktreeModal.test.tsx`

```
     × ignores a stale repo list after the client changes
     × keeps the picked source when a reconnect swaps the client for the same host
     × starts a fresh form session when the modal switches hosts

AssertionError: expected [ '', '' ] to deeply equal [ 'stale-client-name', …(1) ]
AssertionError: expected [ '', '' ] to deeply equal [ 'feat/keep-me', 'feat/keep-me' ]
AssertionError: expected [ 'host-one-name', 'host-one-name' ] to deeply equal [ '', '' ]
      Tests  3 failed | 6 passed (9)
```

The first of those is the pre-existing test; its incidental `['', '']` assertion encoded the
remount-on-client-swap behaviour and is now flipped to assert the form survives, with a comment
pointing at the new reconnect test.

### C — `mobile/src/tasks/smart-source-paste-concurrency.test.ts`

```
 FAIL  src/tasks/smart-source-paste-concurrency.test.ts > smart source paste lookup concurrency
       > issues the pasted-number lookup while the fan-out is still in flight
AssertionError: expected [ 'github.listWorkItems', …(1) ] to include 'github.workItem'
      Tests  1 failed (1)
```

Nothing in the stub ever settles, so the lookup can only be observed if it was issued
concurrently — the assertion cannot pass by accident.

---

## Bug C — measured before / after

Same device, same host, same repo, same query (`16831`), measured in the running app with a
temporary `console.log` around `runSmartSearch` (removed again before commit):

```
BEFORE  [PERF] smartSearch q=16831 fanMs=739 pasteMs=1892 totalMs=2631
AFTER   [PERF] smartSearch q=16831                        totalMs=1480
AFTER   [PERF] smartSearch q=16831                        totalMs=1515
```

**2631 ms → 1480 ms / 1515 ms: ≈1.13 s saved, a 43 % reduction** on the type-a-PR-number path.
The arithmetic is self-consistent — before is exactly `fan + paste` (739 + 1892), after is
`max(fan, paste)`. Only one "before" sample was captured before the fix went in; the two "after"
samples bracket it. On a host with a large repo the fan-out leg is the 4–5 s the brief describes,
so the absolute saving there is larger, not smaller.

What this does **not** fix: the host-side `gh` round trip itself. `github.listWorkItems` is 0.5–1.5 s
here and several seconds on a busy repo, and that is host work. The picker already keeps the
previous rows rendered through the 200 ms debounce and shows a footer spinner, so it does not
blank out; making it faster than the host is out of this lane's reach.

---

## Verification

| Check | Result |
|---|---|
| `cd mobile && npx tsc --noEmit` | clean |
| `cd mobile && npx vitest run src` | **471 files, 3774 passed, 3 skipped, 0 failed** |
| changed-code quality gate | `code quality: 0` / `type-aware code quality: 0` / `React Doctor: 0` — **passed since fecdf0bde885** |
| `oxfmt` | run scoped to the 10 changed files only |
| `mobile/pnpm-lock.yaml` | untouched; `grep -c patchedDependencies` → `1` |

`pnpm run check:code-quality:changed` crashes on this machine's Node 26 (the pnpm
`Unsupported engine` warning lands on stdout and `parseOxlintOutput` parses it). Ran as
`npm_config_loglevel=error node config/scripts/check-changed-code-quality.mjs`, which is the same
script with the warning silenced — output quoted above.

---

## Emulator QA

Done on **iPhone 17 Pro Max only**; iPhone 17 Pro and iPhone 17 were never touched. All UI
interaction went through `orca emulator tap` / `orca emulator type`; no Computer Use clicks,
keystrokes, scrolls, or focus changes were performed at any point.

* `lane1-evidence/04-fixed-source-picker-open.png` — picker open on the fixed build.
* `lane1-evidence/05-fixed-form-returns-with-pr.png` — **the form sheet returns holding
  PR #16836**, measured back on screen within 1 s of the tap (sheet-band luma 37.07 at t+1 s and
  t+5 s, versus 8.78 in the dead state).

One deviation from the skill worth flagging: `orca computer list-windows --app
com.apple.iphonesimulator` returns `windows: []` for this device (it was booted headless via
`simctl boot`), so there was no Simulator window to capture. The screenshots above are
device-pixel frames pulled from the Orca emulator helper's own MJPEG stream
(`http://127.0.0.1:3101/stream.mjpeg`) — the app itself, at native resolution, with no desktop
window and no focus stealing. I did not fall back to any other interaction method.

---

## Honest limits

* **The native trigger for A is not pinned down to a single line.** What is proven is: the sheet
  reaches a laid-out-but-unpainted state (`progress = 1`, `translateY = 0`, correct frame), it is
  reachable from the shipped source-picker flow, and the code has no way back out of it. Fix A1
  addresses the hand-back that the trace shows going unhandled; fix A2 removes the
  no-sheet-at-all state that made it unrecoverable. If the underlying rebuild has another
  trigger, A2 still guarantees the user is never stranded on a dead screen.
* The repro is intermittent (~1 in 12 on a one-repo isolated host). I could not make it fire on
  demand, so "fixed" is supported by the mechanism plus a clean post-fix run, not by a
  before/after on a deterministic repro.
* The `-ss`-before-`-i` trap in the brief is real; every frame timestamp here used output
  seeking.

---

# Confirmation round (2026-08-27, second agent)

A follow-up session on the same worktree and the same **iPhone 17 Pro Max**
(`CCA8A76F-77D1-4461-8318-63C7ED69D28E`, attached by UDID) re-verified the branch on device,
scripted the whole flow through `orca emulator tap`/`type` with a 3-band luma classifier over
frames from the helper's MJPEG stream, and ran attempt blocks against base, the committed fix,
and two candidate heals. Confirmed frames land in `lane1-evidence/07-13`.

## The dead screen was reproduced on base, with the full predicted fingerprint

Under a "commit churn" condition (open the picker over the pinned form, flip Smart↔GitHub tabs
twice — each flip re-runs the source fan-out and re-renders the whole modal content — then select
a row), base hit the dead screen live (`07-confirm-dead-screen-base-tab-churn.png`):

* dimmed workspace list, **no sheet anywhere** — the form's backdrop paints (so the form is
  interactive with `progress = 1`) while the sheet itself does not;
* the accessibility tree collapses to the 6 status-bar nodes — the empty modal window owns the
  screen (`09-confirm-dead-ax-status-bar-only.json`);
* every tap is swallowed; the only escape is a backdrop tap, which closes the whole modal
  (`08-confirm-backdrop-tap-closed-modal.png`) — exactly the user's video.

**Determinism was not achieved.** ~99 valid base attempts across seven conditions (settled-list
selects, mid-search selects, fresh-modal-per-attempt, keystrokes inside the swap window, tab-flip
churn, churn + 4-6 CPU burners through the pinned window) produced exactly one dead hit, in the
churn condition during a spike of unrelated machine load. Commit pressure over the pinned sheet
plus machine load raises the odds; nothing tried forces it on demand. The last hop stays inside
the Fabric commit / Reanimated props race, not on an app-code line.

## The committed fix did NOT close the hole — A1's re-assert was a no-op

On the committed branch build (verified served: `hostEpochRef` in the bundle), the identical
churn block hit the **same dead state 1 in 25** (`12-committed-fix-still-dead-1-of-25.png`,
band-identical to the base dead frame). Mechanism: at hand-back `translateY` is already 0 and
`progress` already 1, so `withTiming(1)` produces no style delta and nothing reaches the native
view — the committed A1 cannot heal the state it targets.

A value-level strengthening (seed a sub-pixel `translateY` nudge so the style output changes)
was built, unit-tested, and **also died on device** (1 in 9, `13-nudge-fix-still-dead-1-of-9.png`):
when the native view is rebuilt with a new tag, shared-value writes land on the stale binding.

## The shipped heal: remount the sheet's view on window hand-back

`MountedBottomDrawer` now keys the sheet's `Animated.View` on a `windowEpoch` that increments
whenever a visible sheet takes the window back (`interactive` false → true). The fresh native
view mounts with the style computed from the **current** shared values — `progress` is already 1,
so it paints in place with no visible animation and no feel change. This is the in-app
equivalent of the tint/Fast-Refresh experiment above, the only intervention that provably
repaints. Cost: the sheet's native subtree is rebuilt once per picker close, and its scroll
position resets (the user is at the form top at that moment anyway).

Regression test: `bottom-drawer-window-handback.test.ts` now asserts the hand-back remount via
the epoch-carrying `nativeID` (fails against the committed code: `expected undefined to be
defined`) and keeps the no-remount-while-pinned guard.

## Rates, same device, same host, same steps (churn condition, fresh modal per attempt)

| build | attempts (valid) | dead |
|---|---|---|
| base `fecdf0bde8` | ~99 across all conditions | **1** (+ first agent's independent live repro) |
| committed fix `b99232f764` | 24 | **1** |
| nudge variant (discarded) | 9 | **1** |
| **remount build (this branch)** | **50 (44 valid selections)** | **0** |

`11-remount-fix-form-returns-with-pr.png` shows the form back on screen ~1.9 s after the row
tap, still holding the picked PR (#16908). One 25-attempt block that overlapped source edits
(Metro Fast Refresh mid-block) was discarded as mixed-build.

## Confirmation-round honest limits

* The dead state is rare at rest (~1-4 % per attempt under churn on this rig). 0/44 on the
  remount build is strong but not proof; the mechanism argument (remount is the only heal that
  rebinds a rebuilt native view, verified negatively twice) carries the rest of the weight.
* The software keyboard could not be exercised (`orca emulator type` injects HID events without
  raising it), so keyboard-dismissal-during-swap remains untested as an amplifier.
* Bug B's reconnect-remount and Bug C's latency numbers were not re-measured; the first agent's
  regression tests and measurements stand.
* Rig incidents, all recovered and none affecting results: the dev-client app terminated three
  times during long tap-loops (no crash report — likely jetsam); one scripted recovery tap
  accidentally submitted the create form up to the setup-trust sheet, which was cancelled with
  nothing created (verified against the host's worktree list); a later stray tap opened one idle
  Terminal tab in the "main" session of the **lane1 dev instance** — it runs no commands and
  dies with that dev host.
