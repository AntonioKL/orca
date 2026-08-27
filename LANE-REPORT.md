# Lane 3 — Native chat shows "Start a chat with Claude" while the agent is running

Branch: `brennanb2025/mob-native-chat-empty` (off `origin/main` @ `fecdf0bde8`)
Worktree: `/Users/brennanbenson/orca/workspaces/orca/mob-native-chat-empty`

## Root cause, in one sentence

`mobile/src/session/mobile-native-chat-eligibility.ts` derives the pane's whole transcript
address — **both** `sessionId` and `transcriptPath` — from `tab.agentStatus.providerSession`, so an
agent whose hook identity never reached the host leaves both null; the subscribe effect in
`mobile/src/session/use-mobile-native-chat-session.ts` opens with `if (!sessionId) { return }` and no
transcript is ever requested; and `mobileNativeChatEmptyState` in
`mobile/src/session/mobile-native-chat-render-data.ts` returned the **identical** `empty` copy for
`waiting-session`, `awaiting-transcript` and `ready`, so "we cannot address this transcript" was
rendered as "your conversation is empty" — under a footer saying "Agent is working".

## Two corrections to the brief, both load-bearing

Both were checked against the code, not assumed.

1. **The effect is not a latching one-shot.** `sessionId` is in its dependency list
   (`[client, agent, sessionId, transcriptPath, identity, setList]`), so a session id that arrives
   later *does* re-run it and subscribe. Adding a retry around the null would have been a no-op fix.
   The toggle does not help for a different reason: `sessionId` is still null on the way back, because
   the client has no other source for it. **The address, not the retry, is the defect.**
2. **"The client resolves the session from the transcript path it already has" is not available.**
   `transcriptPath` comes from the same `providerSession` object as the id, so when the id is null the
   path is null too. The client holds nothing to resolve from.

## Evidence review (frames + the real transcript)

`~/orca-qa/mobile-video-triage-2026-08-27/rec2.mp4`:

- `t010` (t=4.5s): "Start a chat with Claude" over the tab context menu; `t004` catches the same pane
  with the footer reading **"Agent is working ⋯ Tools ⏹ Stop"**. `t062`/`t068` show the terminal view
  with the full live session. So the pane definitely carried `agentStatus.state === 'working'` —
  `nativeChatAgentWorking` is `activeChatResolution != null && activeTabStatus?.state === 'working'`.
- The empty copy (not a spinner) means the status was one of `waiting-session`,
  `awaiting-transcript`, or `ready`: `MobileNativeChatView` only draws the spinner for
  `status === 'loading' && messages.length === 0`.
- The angelshark session in the clip is `8b0ec5dc-099a-40c7-a536-613aa47a1c23`; its transcript file
  was **born 07:12:55**, and the recording's status bar reads 07:13 throughout, so the pane was
  ~30–60s into a brand-new hand-started session when it showed the empty state.

**I could not narrow it to one of those three statuses from the recording — and that is the point.**
All three rendered byte-identical copy, so the video cannot distinguish "no session id" from
"transcript not on disk yet" from "genuinely empty". That is exactly the diagnosability defect in
fix (b), and it is why fix (a) had to cover the address rather than one guessed sub-case.

## Fix (a) — a running agent reaches native chat without a published `providerSession`

**Seam chosen: the client asks the host's existing session index, and refuses to guess.**

Why not the other two seams the brief offered:

- *Host publishes `providerSession` for agents it did not launch* — the host has nothing to publish.
  `getHookAgentRowForPane` already keeps `providerSession` **unbounded** per pane and
  `toMobileSessionTabsResult` already merges the hook row's session over a renderer row that lacks
  one (`orca-runtime.ts:34740`). If no hook ever reported for the pane, the host is as blind as the
  client. Manufacturing one would mean the host guessing — and it would also be a **host publication
  change**, which per `docs/reference/remote-wire-compatibility.md` reaches old clients even with no
  wire change. Rejected.
- *Client resolves from the transcript path it has* — it has none (correction 2 above).

What I did instead: `aiVault.listSessions` is already on the mobile RPC allowlist
(`src/main/runtime/runtime-rpc.ts`), already used by Agent Session History, already host-side,
already 15s-cached, and already scoped by `scopePaths`. Its `AiVaultSession` rows carry exactly what
`nativeChat.subscribe` needs: `agent`, `sessionId`, `filePath`, `cwd`, `modifiedAt`, `subagent`.
Reusing it means **no new RPC, no new stream opcode, no host publication change, no wire negotiation**.
A host too old to serve the method fails the request and the pane falls back to the honest
"No conversation linked yet" state.

- `mobile/src/session/mobile-native-chat-session-recovery.ts` (new, pure) —
  `resolveMobileNativeChatRecoveredSession` adopts a transcript **only when unambiguous**. It refuses if:
  - another tab in the worktree runs the same agent and is also unaddressed (nothing distinguishes
    which transcript is whose);
  - the candidate is already some other tab's published session;
  - it is a Task subagent transcript, sits in a different `cwd`, has no `filePath`, or was last
    written longer ago than `AGENT_STATUS_STALE_AFTER_MS` (it cannot belong to a live pane).

  Among survivors the newest-written wins — a live session is the one still being appended to.
  **Showing another agent's conversation is a worse failure than showing none**, so every ambiguous
  case degrades to the honest empty state rather than picking.
- `mobile/src/session/use-mobile-native-chat-session-recovery.ts` (new) — fires only for a pane the
  user is actually looking at whose live status published no session id. Best-effort: a failed or
  unsupported call is swallowed, never an unhandled rejection.
- `mobile-native-chat-eligibility.ts` — takes an optional recovered address; **a published
  `providerSession` always outranks it**, and a recovery captured for a different agent is ignored.
- The route feeds every terminal tab's `(id, agent, sessionId)` in for the ambiguity guard, and the
  tab's `startupCwd` (newly surfaced on `MobileSessionTab`; the host already emitted it) scopes the scan.

SSH: nothing here touches execution. The scan runs on the execution host, which owns its own
filesystem; the client only forwards ids and paths it was handed.

## Fix (b) — the three pre-message states are now distinguishable

`src/shared/native-chat-empty-state.ts` gains three entries (additive; desktop's
`NativeChatEmptyState.tsx` reads `loading`/`error`/`notAgent`/`empty` and is unaffected):

| status | title | subtitle |
| --- | --- | --- |
| `waiting-session` | No conversation linked yet | Orca has not received a session id for this Claude terminal. Switch to terminal view to keep working. |
| `awaiting-transcript` | Transcript not written yet | Claude has not saved this conversation to disk. It appears here as soon as it does. |
| `ready` + agent working | Claude is working | This conversation has no messages yet. Turns appear here as they are written. |
| `ready` + agent idle | Start a chat with Claude | Ask Claude to inspect code, explain output, or make a change. |

`mobileNativeChatEmptyState` now takes `agentWorking`, so "Start a chat with Claude" can never sit
above a live working indicator again — that contradiction was the specific lie in the report.
Copy follows `docs/STYLEGUIDE.md` ("concise and specific… direct verbs and concrete nouns", empty
states name the action available); the existing centered title/subtitle treatment is reused verbatim.

## Regression tests — failing run against the UNFIXED code

Source files reverted to `HEAD` (`src/shared/native-chat-empty-state.ts`,
`mobile-native-chat-render-data.ts`, `mobile-native-chat-eligibility.ts`), tests kept:

```
 RUN  v4.1.9 .../mob-native-chat-empty/mobile

 ❯ src/session/mobile-native-chat-eligibility.test.ts (14 tests | 1 failed) 5ms
     × addresses the transcript when the live status published no provider session 3ms
 ❯ src/session/mobile-native-chat-render-data.test.ts (30 tests | 4 failed) 9ms
     × renders a distinct title and subtitle for each pre-message state 4ms
     × names the agent and the recovery in the no-session copy 1ms
     × does not invite a first message while the agent is mid-turn 0ms
     × falls back to "the agent" when the agent is unknown 1ms

 FAIL  ... > addresses the transcript when the live status published no provider session
  {
    "agent": "claude",
-   "sessionId": "sess-recovered",
-   "transcriptPath": "/tmp/recovered.jsonl",
+   "sessionId": null,
+   "transcriptPath": null,
  }

 FAIL  ... > renders a distinct title and subtitle for each pre-message state
AssertionError: expected [ 'Start a chat with Claude', …(2) ] to deeply equal [ 'No conversation linked yet', …(2) ]

 Test Files  2 failed (2)
      Tests  5 failed | 39 passed (44)
```

The distinguishability assertion compares derived values, not shapes:

```ts
const copies = STATUSES.map((status) => mobileNativeChatEmptyState(status, 'claude'))
expect(copies.map((copy) => copy?.title)).toEqual([
  'No conversation linked yet', 'Transcript not written yet', 'Start a chat with Claude'
])
expect(new Set(copies.map((copy) => JSON.stringify(copy))).size).toBe(STATUSES.length)
```

Pre-fix the set collapses to 1. No `not.toMatch` anywhere.

`mobile-native-chat-session-recovery.test.ts` is a new-module unit suite (11 cases) covering every
refusal branch; being new code it has no pre-fix counterpart, and I am not claiming one.

While wiring this up I also found a **false-green test double**: `use-mobile-native-chat-controller.test.ts`
stubbed `sendRequest: vi.fn()`, which returns `undefined` where the real client always resolves an
`RpcResponse`. It now defaults to `mockResolvedValue({ ok: false })`.

## Gates

| Gate | Result |
| --- | --- |
| `cd mobile && npx tsc --noEmit` | clean |
| `pnpm tc` (root, all projects) | clean, exit 0 |
| `cd mobile && npx vitest run src/session` | **137 files / 1258 tests passed**, 0 errors |
| desktop `NativeChatEmptyState` + `locale-english-regression` | 5 passed |
| `pnpm run check:code-quality:changed` | **passed** — 0 code-quality, 0 type-aware, 0 React Doctor findings across 13 changed files |
| `npx oxfmt <changed paths>` | applied (scoped, never a bare `pnpm format`) |

`check:code-quality:changed` crashes under Node 26 (the pnpm engine WARN lands in the oxlint JSON
stream). Workaround that made it run: `npm_config_loglevel=error pnpm run check:code-quality:changed`.

Two mobile files fail **only** when vitest is invoked from the repo root
(`use-initial-session-terminal-autocreate.test.ts`, `use-mobile-native-chat-send-error.test.ts`) —
`react-test-renderer` act/fake-timer failures from the wrong setup file. Neither imports anything I
changed, and both pass from `mobile/`, which is the documented invocation.

## Simulator QA — iPhone 17 (`ECF690AB-8A0D-47F0-8944-4C464391B93F`)

Rig: branch Metro (`./node_modules/.bin/expo start --host lan --port 8099`, never `pnpm start`) →
isolated dev host (`ORCA_DEV_USER_DATA_PATH=/tmp/lane3-host/userdata ORCA_DEV_INSTANCE_KEY=lane3`,
proven isolated: `window.api.repos.list() → []`) → LAN pairing deep link → **Host 4** connected.
All UI interaction via `orca emulator` only. Frames pulled from the emulator helper's own MJPEG
stream (device pixels, no focus stealing).

`orca emulator attach 'iPhone 17'` **prefix-matched and attached iPhone 17 Pro** (someone else's
booted device). No interaction was sent to it — the helper for that device was already running with
the same pid before my call. Re-attached by UDID immediately. **Attach by UDID, never by name.**

What was proved on device:

1. **Fix (b), directly.** An Orca-launched, unprompted Claude tab (session id published, transcript
   file never written = `awaiting-transcript`) now renders **"Transcript not written yet / Claude has
   not saved this conversation to disk. It appears here as soon as it does."** Pre-fix that exact
   state rendered "Start a chat with Claude / Ask Claude to inspect code, explain output, or make a
   change." Frames: `/tmp/lane3-host/f19.jpg` (terminal view) → `f20.jpg` (context menu, "Switch to
   chat view") → `f21.jpg` (the new copy).
2. **The eligibility gap, directly.** I built a genuinely hand-started agent from the phone: created
   a tab, aborted Orca's launched Claude with Esc, then ran `env -u ORCA_PANE_KEY claude` through
   live input. It ran, answered, and wrote `~/.claude/projects/-private-tmp-lane3-repo/7776c371-….jsonl`.
   Its tab context menu has **no "Switch to chat view" item at all** (`f16.jpg`), while the
   Orca-launched sibling does (`f20.jpg`).

### What the simulator arm did NOT prove — stated plainly

I could not construct the reported host state on the rig: **`agentStatus` present and live, but
`providerSession` absent**. Unsetting `ORCA_PANE_KEY` suppresses the whole hook, so the pane loses
its agent identity too and `canShowMobileNativeChat` returns false before the recovery path is ever
consulted. So **fix (a) is verified by unit tests, not by a device screenshot.** I am not claiming
otherwise.

That gap is itself a finding worth carrying forward: **there is a second, adjacent bug** — a pane
running a recognizable agent with a readable transcript is not offered native chat at all when its
hook identity is missing, because `resolveMobileNativeChat` requires `agentStatus.agentType` or
`launchAgent`. Fix (a) makes the transcript addressable *once the pane is eligible*; it does not
widen eligibility. Widening it is a separate change and I did not make it unasked.

Skill deviations, both deliberate:

- **`pnpm start` was not used** in `mobile/` (the skill suggests it) — a bare `pnpm` there resolves to
  Homebrew pnpm 11 and silently drops `patchedDependencies`. Verified after the run:
  `grep -c patchedDependencies mobile/pnpm-lock.yaml` → `1`, lockfile unmodified.
- **The Computer Use desktop-window capture was skipped.** `orca computer list-windows --app
  com.apple.iphonesimulator` returns `windows: []` — my device was booted headlessly by the emulator
  helper, so there is no Simulator window for it, and capturing the one that does exist would have
  photographed another lane's device. Screenshots came from my device's own MJPEG stream instead.
  Computer Use was never used to interact with anything.
- `orca emulator` drag/long-press: a single `gesture` call with timed points does **not** long-press.
  What works is two separate `exec` calls —
  `gesture '{"type":"begin",…}'`, wait ~1.3s, `gesture '{"type":"end",…}'`.
- `orca emulator type` drops the first character on a freshly focused live-input field, and iOS turns
  a typed double-space into ". ". Type a throwaway lead character, or verify the echo before Enter.

Screenshots are in `/tmp/lane3-host/` (`f1`–`f21.jpg`) and were not committed.

## Files changed

```
 mobile/app/h/[hostId]/session/[worktreeId].tsx           | +18
 mobile/src/session/MobileNativeChatView.tsx              |   2 +-
 mobile/src/session/mobile-native-chat-eligibility.ts     | +27 -6
 mobile/src/session/mobile-native-chat-eligibility.test.ts| +58
 mobile/src/session/mobile-native-chat-render-data.ts     | +22 -9
 mobile/src/session/mobile-native-chat-render-data.test.ts| +52 -15
 mobile/src/session/mobile-native-chat-session-recovery.ts       | new
 mobile/src/session/mobile-native-chat-session-recovery.test.ts  | new
 mobile/src/session/use-mobile-native-chat-session-recovery.ts   | new
 mobile/src/session/use-mobile-native-chat-controller.ts  | +23
 mobile/src/session/use-mobile-native-chat-controller.test.ts | +4 -2
 mobile/src/session/mobile-session-route-types.ts         |  +2
 src/shared/native-chat-empty-state.ts                    | +20
```

## Follow-ups I did not take (out of scope, flagged rather than done)

1. **Native chat is not offered at all to a pane with a readable transcript but no hook identity**
   (see above). Widening `resolveMobileNativeChat` to accept PTY/title-derived agent evidence would
   close it, and would also make fix (a) reachable in exactly the case that produced this report.
2. `use-mobile-native-chat-session.ts` has no bounded re-subscribe while settled in
   `awaiting-transcript`. The host's transcript watcher is supposed to push once the file appears; if
   it ever misses, the pane now says so honestly instead of lying, but does not self-heal. Desktop
   already has `native-chat-read-retry-timer.ts` that could be promoted to `src/shared/` and reused.
