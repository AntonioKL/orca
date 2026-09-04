---
name: orca-per-workspace-env
description: >-
  Set up, review, debug, or validate an Orca per-workspace environment recipe: the
  on-demand, disposable runtime (cloud sandbox, VM, SSH host, or local container)
  Orca creates fresh for each workspace. Use to stand up a new recipe end to end,
  fix an `environmentRecipes` entry in `orca.yaml`, scaffold provider lifecycle
  scripts, or resolve an `orca vm recipe doctor` failure. Use `orca-cli` for
  ordinary worktree and workspace creation with no recipe involved.
---

# Per-Workspace Environments

**Result:** a repo-owned `environmentRecipes` entry in `orca.yaml`, the provider lifecycle
scripts under `scripts/orca-vm/` it points at, and an authenticated base snapshot recorded in a
state file.

**Next consumer:** the Orca workspace composer. It reads `environmentRecipes` from the project's
registered checkout, offers the recipe as a "Run on" target, and runs
`create`/`suspend`/`resume`/`destroy` against it.

**Done:** `ORCA vm recipe doctor <recipe-id> --repo-path <repo> --provision --json` returns
`ok: true` with no check at status `warn` (a `warn` leaves `ok` true, so read the checks), and
the recipe is on the project's primary branch. Only the user can defer that placement, and only
by saying so.

**Safe failure:** stop and report the provider's own error text and the command that produced it.
Never replace a provider error with a generic message, and never leave a paid resource running.

`ORCA` is a placeholder for the executable you used to run `skills get`. Substitute it before
running anything; do not create a shell variable or run `ORCA` literally. The placeholder does
not apply inside the lifecycle scripts: a command such as `orca serve` written there executes on
the remote machine with that machine's own binary.

## Autonomy envelope

Invoking this workflow authorizes, without asking again: reading the repo and its `orca.yaml`,
detecting provider CLIs and their login state, scaffolding and editing files under
`scripts/orca-vm/`, and running `ORCA vm recipe doctor` without `--provision`. Stop and get an
explicit OK before anything that provisions a paid resource. The paid steps are the base snapshot,
the auth snapshot, and `--provision`. One OK covers the whole `--provision` fix-and-rerun loop, so
do not re-ask per iteration. Stop for the interactive agent login, which you cannot drive: the user runs
it and tells you when it finished. Never create an Orca workspace except for the step-10 test the user asked for. Never commit,
choose a plan or region, invent a scope, project, or billing id, or write a credential into a script, `userData`, the state
file, or a commit.

## The branch that shapes everything

In **Orca-server** mode `create` runs `orca serve` in the environment and emits a `pairingCode`. In
**SSH** mode `create` runs no server and emits a `connection.type:"ssh"` block that Orca dials into.
Settle this first: it changes the `create` output shape and half the templates.

Keep Orca's checkout behavior unchanged by default: omit `checkoutMode`, emit schema version 1, and
let Orca create a linked worktree. Use `checkoutMode: provisioned-root` only when the user
explicitly wants one ephemeral machine to clone the finished workspace itself. That mode requires
direct SSH, an ordinary non-bare and non-sparse primary checkout at `projectRoot`, and schema
version 2.

## 1. Setup workflow

Drive these with the user. Three setup phases run before the per-workspace recipe can run and their
order is invariant: the base snapshot (step 5) is what the auth snapshot (step 6) boots from, and
`create` boots from the authenticated snapshot the two of them produce. A **[CHECKPOINT]** label
marks a step the autonomy envelope above stops for. The envelope is the rule; the label only
points at it.

1. **Inspect the repo** for an existing `environmentRecipes` entry, `scripts/orca-vm/`, a state
   file, or setup notes. If a working recipe already exists, go straight to the doctor loop below
   instead of rebuilding.
2. **Interview the user up front.** Gather these choices and confirm them back before scaffolding
   anything. Do not pick for them and do not guess.
   - **Connection mode:** an Orca server or SSH, as above. Settle it first.
   - **Checkout ownership:** do not ask by default. Only when the user requires the environment to
     create the exact final checkout, confirm `provisioned-root` and direct SSH; otherwise omit it.
   - **Provider:** Vercel Sandbox, Fly, Modal, an existing SSH host, and so on. For a non-obvious
     provider, also ask scope, project, region, and plan limits. Then read that provider's CLI or
     SDK docs, or `<cli> --help`, before scaffolding: you need its exact create, exec, snapshot, and
     remove verbs. If a provider advertises `ssh`, check whether it exposes a real dialable SSH
     target (host, port, user, key or proxy command) or only a provider-mediated interactive shell.
     Orca's SSH mode needs the former.
   - **Coding-agent CLI and account:** which agent runs in the environment (`codex`, `claude`, and
     so on) and that the user has an account for it. It is logged in during step 6.
   - **Git auth:** the token source for cloning a private repo (`GH_TOKEN`, `GITHUB_TOKEN`, or
     `gh auth token`).
3. **Check prerequisites** (section 2) and confirm the items above are in place before any paid
   step.
4. **Scaffold the scripts and state file**, filling in the provider's real commands, and make them
   executable. The per-provider worked examples are in the conditional references below.
5. **[CHECKPOINT] Build the base snapshot** (section 3). Paid and slow.
6. **[CHECKPOINT] Authenticate the agent** (section 4). Interactive; the user follows a URL and code.
7. **Wire the recipe** so `orca.yaml` points create, suspend, resume, and destroy at the scripts.
   Tell the user up front that the composer reads `environmentRecipes` from the project's primary
   checkout, so a recipe that exists only on a branch or in a worktree never appears as a "Run on"
   option. The doctor and `--provision` validate the scripts from the working copy on any branch;
   the picker needs the `orca.yaml` change on the primary branch.
8. **Dry-run the doctor** — free and static.
9. **[CHECKPOINT] Live self-test** — run the `--provision` loop until it passes.
10. **[CHECKPOINT] Optional workspace test** — only if asked: create a workspace via the picker,
    then verify sleep, wake, and delete.

## 2. Prerequisites

These are the user's responsibility. Verify what is verifiable, ask for the rest, invent nothing,
and state which items you verified against which the user asserted.

- **Cloud account and plan** that allows sandboxes or VMs. Ask.
- **Provider CLI installed and authenticated** — detect with `command -v <cli>` and check auth (for
  example `vercel whoami`). If it is missing, point at the provider's docs; do not log them in.
- **Scope, project, and region** the environments live under. Ask; this flows into every script via
  state.
- **Plan, timeout, and RAM caps.** Record them. Vercel's Hobby plan, for example, caps sandbox
  timeout at 45 minutes, which limits both the base build and the per-workspace runtime.
- **Git token for private repos** (`GH_TOKEN`, `GITHUB_TOKEN`, or the provider's git auth, falling
  back to `gh auth token`).
- **Coding-agent CLI choice** and an account for it.

## 3. Base snapshot

Build once, snapshot, and every workspace boots from that image in seconds instead of rebuilding.
Provisioning and building often takes 20 to 30 minutes.

- Build the **headless Electron main only**, not the renderer, so it fits in plan RAM.
- Use the environment image's package manager (`apt`, `dnf`, `apk`, per the base distro, not the
  provider brand).
- Clone with the git token via `GIT_ASKPASS` (section 5).
- Trap errors and remove the half-built environment, so a crash does not leave a paid resource
  running.
- **Never snapshot a machine on which the Orca runtime has already run.** The first `orca serve`
  creates the runtime's user-data directory, and everything in it is baked into the image and shared
  by every environment booted from it: the pairing keypair and device-token registry
  (`orca-devices.json`, `orca-e2ee-keypair.json`), `agent-session-authority.key`, and the build
  box's logs, terminal history, and orchestration database. Two VMs from one such snapshot emitted
  identical `deviceToken` and `pairedDeviceId`. Snapshot before the runtime has ever run, or delete
  the resolved user-data directory first:
  `orca_user_data_path="${ORCA_USER_DATA_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/orca}"; rm -rf -- "$orca_user_data_path"`.
  That matches Orca's Linux precedence for custom and default paths; deleting a named file list
  drifts as Orca adds state.
- Snapshot the stopped environment, parse the snapshot id, and write it plus scope, project, port,
  and repo into state.

## 4. Agent-auth snapshot

The base snapshot has the agent CLI installed but not logged in, and per-workspace environments are
ephemeral. Authenticate once and bake it into a second snapshot layer.

1. Boot an environment from the base `snapshotId` in state.
2. Run the agent's login interactively. **On a headless machine this must be the device-auth flow**
   (for example `codex login --device-auth`), never plain `codex login`: the default OAuth login
   starts a loopback callback server on a port the host browser cannot reach, so it hangs.
   Device-auth prints a URL and code the user opens on the host.
3. Verify the login and refuse to snapshot an unauthenticated machine. **Prefer the status command's
   exit code**, because most agent CLIs exit non-zero when unauthenticated. If you match text
   instead, agent status often goes to stderr, so fold stderr first (`... 2>&1 | grep …`) and match
   the agent's exact success line. Never `grep -qi 'logged in'`, which also matches "not logged in"
   and would commit an unauthenticated image.
4. Re-snapshot, parse the new id, overwrite `snapshotId` in state with the authenticated image, and
   record `authSourceSnapshotId`. Remove the auth environment.

Authenticate inside the disposable runtime and snapshot that layer. Do not bind-mount or copy a host
agent home such as `~/.codex` as the auth snapshot: it carries sqlite state, hook approvals, caches,
and host-specific config that break in the runtime. If the agent's credentials are short-lived, tell
the user the snapshot needs periodic re-auth.

You cannot drive step 2: you run commands non-interactively, so there is no TTY for `docker exec -it`
or `ssh -t` to prompt against. The user runs the login in their own terminal, and you cannot observe
it finishing, so ask them to report back before you verify and re-snapshot.

> Harness adapter: in Claude Code the user can run that login in the session itself with the bang
> prefix, `! <cmd>`, including the required space after `!`. Other harnesses have no such
> affordance; the portable rule is that the user runs it wherever they have a terminal.

This layer inherits section 3's rule. If you started `orca serve` on the base or auth machine to
smoke-test it, delete the runtime's user-data directory before re-snapshotting, or every workspace
booted from this image shares one pairing identity and one `agent-session-authority.key`.

## 5. Credentials

- Never commit secrets or put them in `userData`, recipe JSON, comments, docs, or the state file.
- **Git token:** read it from `GH_TOKEN` or `GITHUB_TOKEN`, falling back to `gh auth token`. Pass it
  to the environment only via the provider's ephemeral `--env`. Inside the environment, use a
  `GIT_ASKPASS` helper with `x-access-token` rather than the token in the clone URL, plus
  `GIT_TERMINAL_PROMPT=0` so a missing token fails fast instead of hanging. When you write that
  helper from inside `bash -lc` under `set -u`, escape the positional argument and the token as
  `\$1` and `\$GH_TOKEN` so they land literally and resolve at git-runtime: an unescaped `$1` aborts
  with "unbound variable", and a literal `$GH_TOKEN` keeps the real token out of the written file.
  `rm -f` the helper after the clone or fetch.
- **Provider auth:** rely on the provider CLI's logged-in session, not checked-in keys.
- **Agent auth:** lives in the authenticated snapshot from section 4, never in a file you write.
- State holds only non-secret wiring: snapshot ids, scope, project, port, repo URL and ref.

## 6. State file

A repo-local JSON file such as `scripts/orca-vm/<provider>-state.json` threads non-secret values
between phases. Each script resolves a value as env var, then state, then a built-in fallback, and
merges its outputs back. The base snapshot writes `snapshotId`; the auth snapshot overwrites it with
the authenticated image; per-workspace `create` boots from `snapshotId`.

```json
{
  "baseName": "orca-base",
  "snapshotId": "snap_authenticated_image_id",
  "authSourceSnapshotId": "snap_base_image_id",
  "scope": "<provider-scope>",
  "project": "<provider-project>",
  "port": 7331,
  "repoUrl": "https://host/org/repo.git",
  "repoRef": "main",
  "projectRoot": "/abs/path/on/remote/repo"
}
```

## 7. Script shapes

Scaffold under `scripts/orca-vm/`. These are shapes: fill in the provider's real commands. **Every
script reserves stdout for its final JSON object and sends all progress and errors to stderr**; a
stray `echo` on stdout corrupts the result. Include a shared `json_value <key>` and
`env_value <NAME>` reader (env, then state, then fallback) in each.

The local-side scripts — `create`, `suspend`, `resume`, `destroy`, and the base-snapshot and auth
scripts the user invokes by hand — run on the user's desktop, so they must run on that OS. On macOS
and Linux use `#!/usr/bin/env bash`, `set -euo pipefail`, and quoted paths. The remote-side commands
you `exec` inside the Linux environment always run in its Linux shell, so bash is fine there
regardless of the desktop OS.

### 7a. Base snapshot (`<provider>-base-snapshot.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail
# resolve base_name/repo_url/repo_ref/project_root/port/scope/project/timeout (env→state→fallback)
# resolve gh token: GH_TOKEN | GITHUB_TOKEN | `gh auth token`
# 1. provision an environment (timeout/vcpus/published port/snapshot retention); trap: remove on error
# 2. remote exec (long timeout): install pkgs + gh + corepack/pnpm + agent CLI;
#    clone with GIT_ASKPASS(token); write headless main-only build config;
#    dev setup; pnpm install; build CLI; build headless electron main; smoke-check tools
# 3. snapshot stopped environment; parse snapshot id (fail if unparseable)
# 4. merge { baseName, snapshotId, projectRoot, repoUrl, repoRef, port, scope, project } into state
# print only the state JSON to stdout
```

You run this by hand, not via `orca.yaml`, after exporting the first-run inputs state does not have
yet: provider scope and project, the repo URL and ref, and a git token. Later runs read them back.

### 7b. Auth (`<provider>-base-auth.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail
# read source snapshot from state.snapshotId (fail if absent); auth_name="${base_name}-auth"
# 1. boot an environment from the source snapshot; trap: remove on error
# 2. INTERACTIVE/TTY remote exec: agent login with the device-auth flow. The user runs this and
#    reports back when it finishes.
# 3. verify login by exit code, then refuse to snapshot if not logged in
# 4. snapshot; parse new id
# 5. merge { snapshotId:<new>, authSourceSnapshotId:<source> } into state; remove auth environment
# print only the state JSON to stdout
```

### 7c. Create (`<provider>-create.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail
# read authenticated snapshotId/scope/project/port/repo*/project_root (env→state→fallback)
# fail clearly if snapshotId is missing (point back to the snapshot phases)
# name = orca-${ORCA_RECIPE_ID}-${ORCA_VM_INSTANCE_ID} (sanitized, length-capped)
# 1. boot from snapshotId with a published port; capture the public URL → pairing address
#    (an externally reachable wss:// URL); trap: remove the environment on error
# 2. remote exec: ensure repo at desired commit; rebuild only if commit changed (cache marker)
# 3. Orca-server mode only: remote exec starting orca serve and reading the recipe JSON it writes
# 4. print one recipe-result JSON object to stdout
```

### 7d. Suspend, resume, destroy

```bash
#!/usr/bin/env bash
set -euo pipefail
payload="$(cat)"                       # Orca passes lifecycle JSON on stdin
resource_id="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.recipeResult?.userData?.resourceId ?? "")' "$payload")"
[ -n "$resource_id" ] || { echo "No resource id in lifecycle payload" >&2; exit 1; }
# suspend: provider suspend "$resource_id"
# resume:  provider resume "$resource_id"; then RE-EMIT fresh recipe JSON (pairing may change)
# destroy: provider remove "$resource_id"   (or set destroy: none in orca.yaml)
```

### 7e. State file

Scaffold it with scope, project, and repo filled in and the snapshot ids empty.

## 8. Recipe result contract

Define recipes in `orca.yaml`:

```yaml
environmentRecipes:
  - id: cloud-sandbox
    name: Cloud Sandbox
    create: ./scripts/orca-vm/cloud-sandbox-create.sh
    suspend: ./scripts/orca-vm/cloud-sandbox-suspend.sh
    resume: ./scripts/orca-vm/cloud-sandbox-resume.sh
    destroy: ./scripts/orca-vm/cloud-sandbox-destroy.sh
```

`create` is required, runs locally from the repo root, and prints exactly one JSON object on stdout.
`suspend` and `resume` are optional and read the lifecycle payload on stdin; `resume` must print
fresh recipe JSON because the pairing may have changed. `destroy` is optional only when the recipe
sets `destroy: none`. The legacy keys `command` and `cleanup` still map to `create` and `destroy`;
prefer the lifecycle names.

The base result, which is what Orca-server mode prints:

```json
{
  "schemaVersion": 1,
  "pairingCode": "orca-pairing-code-or-url",
  "projectRoot": "/absolute/path/to/repo/on/remote",
  "userData": { "provider": "example", "resourceId": "provider-resource-id" }
}
```

`pairingCode` and `projectRoot` are required; `schemaVersion` (`1`) and `userData` are optional.
Three named deltas change that shape:

- **`orca serve --recipe-json` output** is this same object without `userData`. Merge your own
  `userData` into it rather than rebuilding it.
- **SSH mode** replaces `pairingCode` and `projectRoot` with a `connection` block whose `type` is
  `"ssh"`, and does not run `orca serve`. The exact target shape is in `references/ssh-host.md`.
- **Provisioned root** applies only to direct SSH and only when the user explicitly asked for it. Add
  `checkoutMode: provisioned-root` to the recipe, require `ORCA_RECIPE_RESULT_SCHEMA_VERSION=2`, and
  emit `"schemaVersion": 2` with `"checkoutMode": "provisioned-root"`. Fail if the requested schema
  is not `2` rather than falling back to the ordinary shape. Details are in `references/ssh-host.md`.

### The `orca serve` invocation

Inside the environment, in Orca-server mode, run exactly this. These flags are verified; do not
improvise them.

```bash
orca serve \
  --port "$PORT" \
  --project-root "$ABS_REPO_PATH_ON_REMOTE" \
  --pairing-address "$EXTERNAL_WSS_URL" \
  --recipe-json
```

In an environment built from source, run it as `pnpm exec orca-dev serve …` from the repo root;
`orca-dev` is the in-repo entrypoint. Plain `orca serve …` is the same command when the built CLI is
on that machine's PATH, and the flags and output are identical either way. There is no `--host` flag,
and `--project-root` must be an absolute directory on the remote.

`pairingCode` already points at whatever you passed as `--pairing-address`, so set that flag to the
externally reachable address and pass `pairingCode` through unchanged; never hand-rewrite it.
Tunneling and port mapping are the script's job. With `--recipe-json` the server stays running and
does not exit, so redirect its stdout to a file and poll until that file parses as JSON, bailing and
dumping its stderr log if the process dies.

## 9. Doctor and the `--provision` loop

`ORCA vm recipe doctor <recipe-id> --repo-path <repo> --json` validates static wiring only; it boots
nothing. It checks local-host execution, the repo path, that the recipe id exists, that the create,
destroy, suspend, and resume command paths resolve, that suspend and resume are paired, and that
each script is executable (the POSIX exec bit, skipped on Windows).

**This free gate is clear only when no check has status `fail` and no check has status `warn`.**
A `warn` still leaves `ok: true`, so `ok: true` alone does not clear the gate. Before spending money
on `--provision`, resolve each `warn` or state the reason you are accepting it.

Adding `--provision` runs the recipe end to end: it executes `create`, validates the returned recipe
JSON, then runs `destroy` to tear the environment back down, so the test leaves nothing running as
long as `destroy` works. `--connect` is an accepted synonym for `--provision`, so the envelope's money
boundary covers both.

Run it as a loop: read the `provisionTranscript` the failed result carries, fix the script, and
re-run `--provision` until `ok` is `true`, rather than waiting for the user to paste errors. Reading
that transcript is in `references/failure-modes.md`.

The self-test cannot see provider-side truth beyond what the scripts print, so confirm separately
that state holds a populated **authenticated** `snapshotId` and that `destroy` is implemented and
tested, or explicitly `none` — in which case the self-test tears nothing down and you must clean up
manually.

## Conditional references

This kernel is sufficient for the interview, the phase order, and the doctor loop. At an action gate
below, run `ORCA skills get orca-per-workspace-env --full` once and read only the named reference:
that returns this exact kernel plus every reference from the same CLI build. A read you made before
reaching the gate does not satisfy it. If an older CLI rejects `--full`, keep this kernel's rules,
use that command's `--help`, and never guess newer flags.

| Action gate | Bundled reference |
| --- | --- |
| Writing the base-snapshot, auth, or create script for a snapshot-capable cloud provider | `references/provider-vercel.md` |
| The recipe connects over SSH instead of starting `orca serve`, including provisioned root | `references/ssh-host.md` |
| The environment is a local Docker container reached over SSH | `references/docker-ssh.md` |
| The user's desktop is Windows and you are scaffolding local-side scripts | `references/windows-scripts.md` |
| A doctor, provision, clone, login, or snapshot step failed | `references/failure-modes.md` |
