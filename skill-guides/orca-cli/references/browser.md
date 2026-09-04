# Built-in browser commands

Use a snapshot-interact-re-snapshot loop:

```text
ORCA goto --url https://example.com --json
ORCA snapshot --json
ORCA click --element @e3 --json
ORCA snapshot --json
```

Common commands:

```text
ORCA goto --url <url> --json
ORCA back --json
ORCA reload --json
ORCA snapshot --json
ORCA screenshot --json
ORCA full-screenshot --json
ORCA pdf --json
ORCA click --element <ref> --json
ORCA fill --element <ref> --value <text> --json
ORCA type --input <text> --json
ORCA select --element <ref> --value <value> --json
ORCA check --element <ref> --json
ORCA scroll --direction down --amount 1000 --json
ORCA hover --element <ref> --json
ORCA focus --element <ref> --json
ORCA keypress --key Enter --json
ORCA upload --element <ref> --files <paths> --json
ORCA wait --text <text> --json
ORCA wait --url <substring> --json
ORCA wait --selector <css> --json
ORCA wait --load networkidle --json
ORCA eval --expression <js> --json
ORCA tab list --json
ORCA tab create --url <url> --json
ORCA tab switch --index <n> --json
ORCA tab close --index <n> --json
ORCA cookie get --json
ORCA capture start --json
ORCA console --limit 50 --json
ORCA network --limit 50 --json
ORCA exec --command "help" --json
```

Browser rules:

- Re-snapshot after navigation, tab switches, clicks that change the page, and any `browser_stale_ref`.
- Refs like `@e1` are assigned by `snapshot`, scoped to one tab, and invalidated by navigation or tab switch.
- Browser commands default to the current worktree and its active tab. Use `--worktree all` only intentionally.
- For concurrent browser work, run `ORCA tab list --json`, read `tabs[].browserPageId`, and pass `--page <browserPageId>` on later commands.
- Use typed tab commands (`ORCA tab list/create/close/switch`), not `ORCA exec --command "tab ..."`, so Orca keeps UI state synchronized.
- Prefer `wait --text`, `--url`, `--selector`, or `--load` after async page changes instead of bare timeouts.
- Less common workflows can use typed commands above or `ORCA exec --command "<agent-browser command>"` passthrough.
- If `fill` or `type` fails on a custom input, try `ORCA focus --element @e1 --json` then `ORCA inserttext --text "text" --json`.
- Client-hosted pages have interactive-session affinity: the page renders in the paired desktop's own browser engine, so every command against it needs that desktop online, and returns `browser_host_unavailable` while the desktop is closed, asleep, or disconnected. Server-hosted pages keep running with no desktop attached, so prefer server placement for long-running or unattended browser automation.

Common recoveries:

- `browser_no_tab`: open a tab with `ORCA tab create --url <url> --json`.
- `browser_stale_ref`: run `ORCA snapshot --json` and retry with fresh refs.
- `browser_tab_not_found`: run `ORCA tab list --json` before switching or closing.
- `browser_host_unavailable`: the desktop hosting that page is offline. Bring it back, or create the page for server placement when the work must survive without an interactive session.
