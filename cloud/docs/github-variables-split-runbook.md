# GitHub variables: relay / app identity split runbook

Owner-run. Every `gh variable` and `gh api` write below mutates repository
settings and is **not** executed by automation. Ordering rule throughout: a
name exists before anything references it, and an old name is deleted only
after one green run on the new one.

Read-only inventory (2026-09-03, `per_page=100`):

| scope | names |
| --- | --- |
| repository (fallbacks) | `PRODUCTION_GCP_{DEPLOY_SERVICE_ACCOUNT,WORKLOAD_IDENTITY_PROVIDER,REGION}`, `PRODUCTION_GCP_RELAY_MONITOR_{SERVICE_ACCOUNT,WORKLOAD_IDENTITY_PROVIDER}`, `STAGING_GCP_{DEPLOY_SERVICE_ACCOUNT,WORKLOAD_IDENTITY_PROVIDER,REGION}` |
| `production` environment | the 3 generic production names above **plus** `PRODUCTION_GCP_APP_*` and every `PRODUCTION_GCP_RELAY_*` |
| `staging` environment | only the 6 `STAGING_GCP_RELAY_{CAPACITY,ASIA_TOPOLOGY,ASIA_PROOF}_*` names |

The three generic production values in the repository scope are identical to
their `production` environment copies (verified by digest). Staging's generic
trio and `STAGING_GCP_REGION` exist **only** at repository scope.

## Why

`PRODUCTION_GCP_WORKLOAD_IDENTITY_PROVIDER` / `PRODUCTION_GCP_DEPLOY_SERVICE_ACCOUNT`
are the shared `github_deploy` identity. Ten relay workflows read them; the
two app deploys already moved to `PRODUCTION_GCP_APP_*`. After the extraction
the relay workflows run from `stablyai/orca`, whose variables are a separate
namespace, so the relay side needs names that describe what they are
(`RELAY_DEPLOY`) and that can be created in the public repo without touching
the app pair. Repository-level fallbacks are removed because they let a
workflow with no `environment:` key authenticate to production.

## Phase G1: production relay deploy names (before extraction, no behaviour change)

1. Create the new names in the `production` environment with the **current**
   values. The Terraform outputs are the source of truth; the environment
   variables must match them byte for byte.

   ```sh
   terraform -chdir=infra/terraform output -raw github_workload_identity_provider
   terraform -chdir=infra/terraform output -raw github_deploy_service_account
   gh variable set PRODUCTION_GCP_RELAY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER --env production --body '<reviewed output>'
   gh variable set PRODUCTION_GCP_RELAY_DEPLOY_SERVICE_ACCOUNT            --env production --body '<reviewed output>'
   ```

   Confirm both copies before repointing anything:

   ```sh
   for n in PRODUCTION_GCP_RELAY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER PRODUCTION_GCP_RELAY_DEPLOY_SERVICE_ACCOUNT; do
     gh api "repos/stablyai/orca-cloud/environments/production/variables/$n" --jq .name
   done
   ```

2. Merge the repoint PR (lands with the lease wiring; it touches the same ten
   files). It replaces the two generic names in:
   `deploy-relay-fence-broker`, `deploy-relay-production`,
   `deploy-relay-production-director`, `deploy-relay-production-capacity`,
   `deploy-relay-production-capacity-job`, `deploy-relay-production-multi-target`,
   `deploy-relay-production-same-cap-job`, `operate-relay-production-rehome-job`,
   `operate-relay-asia-admission` (production arm), `publish-relay-production`.
   The identity-boundary test gains a census: no workflow under
   `.github/workflows/` may name `PRODUCTION_GCP_WORKLOAD_IDENTITY_PROVIDER` or
   `PRODUCTION_GCP_DEPLOY_SERVICE_ACCOUNT`.

3. One green run on the new names: `Monitor Relay Production` does not use the
   pair, so run `Publish Relay Production` (image only, no rollout). Then
   delete the old names, environment first, repository second:

   ```sh
   gh variable delete PRODUCTION_GCP_WORKLOAD_IDENTITY_PROVIDER --env production
   gh variable delete PRODUCTION_GCP_DEPLOY_SERVICE_ACCOUNT     --env production
   gh variable delete PRODUCTION_GCP_WORKLOAD_IDENTITY_PROVIDER
   gh variable delete PRODUCTION_GCP_DEPLOY_SERVICE_ACCOUNT
   ```

## Phase G2: retire the remaining repository-level production fallbacks

`PRODUCTION_GCP_REGION` and the two `PRODUCTION_GCP_RELAY_MONITOR_*` names
have identical copies in the `production` environment, and every reader
declares `environment: production`. Delete the repository copies only after
G1's green run proved the environment copies serve:

```sh
gh variable delete PRODUCTION_GCP_REGION
gh variable delete PRODUCTION_GCP_RELAY_MONITOR_WORKLOAD_IDENTITY_PROVIDER
gh variable delete PRODUCTION_GCP_RELAY_MONITOR_SERVICE_ACCOUNT
gh api "repos/stablyai/orca-cloud/actions/variables?per_page=100" --jq '.variables[].name'   # expect only STAGING_* left
```

## Phase G3: staging (owner action already open in the checklist)

Staging's generic pair and region live only at repository scope, and every
staging reader except `operate-relay-asia-admission` declares
`environment: staging`. Create the environment copies first so the
`environment:` scoping is real, then split the same way as production:

```sh
gh variable set STAGING_GCP_REGION                                 --env staging --body '<current repository value>'
gh variable set STAGING_GCP_APP_WORKLOAD_IDENTITY_PROVIDER         --env staging --body '<current STAGING_GCP_WORKLOAD_IDENTITY_PROVIDER>'
gh variable set STAGING_GCP_APP_DEPLOY_SERVICE_ACCOUNT             --env staging --body '<current STAGING_GCP_DEPLOY_SERVICE_ACCOUNT>'
```

App readers to repoint to `STAGING_GCP_APP_*`: `deploy-staging`,
`deploy-auth-staging`, `recover-skill-object-staging`,
`load-skill-finalization-staging`. Relay readers
(`deploy-relay-staging`, `deploy-relay-staging-gce-candidate`,
`bootstrap-relay-staging-capacity`, `power-relay-staging`,
`operate-relay-asia-admission` staging arm) move to
`STAGING_GCP_RELAY_DEPLOY_*` **in PR 13**, because that identity does not
exist yet: staging's `github_deploy` is apps-owned and PR 13 creates the
relay-owned `github_staging_relay_deploy` account and provider. Until PR 13,
the relay readers keep the generic names and the generic names stay.

`operate-relay-asia-admission` has no fixed `environment:`; it uses
`${{ inputs.environment }}`, so the environment copies serve it once they exist.

## Phase G4: after extraction (public repo)

Create in `stablyai/orca`, in a `production` environment restricted to
`main`, only the relay names: `PRODUCTION_GCP_REGION`,
`PRODUCTION_GCP_RELAY_DEPLOY_*`, `PRODUCTION_GCP_RELAY_{MONITOR,FENCE,CAPACITY,ASIA_TOPOLOGY}_*`,
`PRODUCTION_GCP_RELAY_{DIRECTOR_RUNTIME,RUNTIME}_SERVICE_ACCOUNT`,
`PRODUCTION_GCP_RELAY_FENCE_BROKER_URI`; and in `staging`: `STAGING_GCP_REGION`
plus the `STAGING_GCP_RELAY_*` set. Never create an `APP` name there. The
values are unchanged until the WIF providers accept the new repository
(dual-accept step in the extraction checklist).

## Rollback

Every phase is reversible by recreating the deleted name with the value
still present in the other scope; nothing here changes a GCP resource.
