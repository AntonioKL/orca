# Per-Workspace Environments

This file is a discovery stub, not the usage guide. The full, version-matched per-workspace
environment reference is served by the `orca` binary itself — kept out of this file on
purpose so it can never drift from the binary that will actually run your commands.

Engage Orca whenever you set up, review, debug, or validate a per-workspace environment
recipe — the on-demand, disposable runtimes (cloud sandboxes, VMs, or local) created fresh
for each workspace. This covers first-time setup (provider prerequisites, the reusable base
snapshot, the coding-agent auth snapshot, credentials, and state), not just the
per-workspace lifecycle scripts. Use it to stand up per-workspace environments, fix an
`environmentRecipes` entry in `orca.yaml`, scaffold provider lifecycle scripts, or resolve
an `orca vm recipe doctor` failure. Orca is a thin wrapper: you guide, detect, and scaffold;
you never own the user's cloud account, billing, images, or credentials, and never spend
money without an explicit user OK.

<!-- shared: resolver -->

## Load the full guide before running Orca commands

```text
ORCA skills get orca-per-workspace-env
```

That prints the complete, version-matched guide for the exact binary that will handle your
next commands — provider setup, base and auth snapshots, `environmentRecipes` in
`orca.yaml`, lifecycle scripts, and `orca vm recipe doctor`. Read it first, then run the
specific command you need.

<!-- shared: no-guessing -->

<!-- shared: older-binary-intro -->

```text
ORCA status --json
ORCA vm recipe doctor <recipe-id> --repo-path <repo> --json
```

The doctor command above is the free static check. Never add `--provision` without the
user's explicit approval because it creates provider resources and may spend money.

<!-- shared: older-binary-outro -->
