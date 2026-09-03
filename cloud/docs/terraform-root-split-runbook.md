# Terraform root split: state surgery runbook

Moves the foundation and apps resources out of the relay root's state and into
the `terraform/foundation` and `terraform/apps` prefixes, one environment at a
time. **Staging first. Production only after staging has passed every gate.**

This is state-only. No `terraform apply` runs against any root. No cloud
resource is created, changed, or destroyed. The relay root's standing drift
(pending cell template replacements, observability backlog) is carried across
unchanged and reconciled separately.

## Preconditions (per environment)

- [ ] PR 6 (`relay-root-carve-removed.tf`) is merged. The `removed` blocks
      convert a stray `pnpm infra:apply` from *destroy 75 resources* into
      *forget 75 resources* during the window. Do not run this runbook
      without them.
- [ ] **Do not attempt an untargeted `terraform plan` on the relay root before
      the push.** It fails with `Error: Cycle` in both environments for the
      whole window, and that is the safe failure, not a signal to stop. Every
      relay GCE instance template is `create_before_destroy` and still lists
      `google_project_service.required`, `google_project_service.sqladmin`,
      and `google_sql_database_instance.auth` in its state `dependencies`;
      with those three carved out of config, Terraform cannot order the
      template's replacement against their removal. Targeted plans build a
      reduced graph and are unaffected, so every CI workflow keeps working,
      and the cycle is gone the moment this runbook's push lands.
- [ ] No relay workflow is running or queued. For production, additionally
      confirm none of `deploy-relay-production-capacity`,
      `deploy-relay-production-multi-target`, `deploy-relay-production-same-cap`,
      `operate-relay-production-rehome`, `operate-relay-asia-admission`,
      `publish-relay-production` is in flight.
- [ ] **No recoverable fence attempt record exists.** The fence tooling treats
      a state serial of exactly `attempt + 1` as a completed fence, and this
      surgery advances the relay serial once per moved family (up to 75),
      so any pending attempt's `attempt + 1` may be crossed. List
      `gs://<project>-terraform-state/terraform/state/relay-fence-plans/<env>/`
      and confirm it is empty or every record is terminal. The lease object
      `terraform/state/relay-fence-broker/production.lock` must also be absent.
- [ ] Staging: the data plane may be asleep; this runbook does not need it
      awake because nothing is applied. The `infra.mjs` sleep guard is not on
      this path.
- [ ] Operator has `roles/storage.objectAdmin` on the state bucket and a fresh
      `gcloud auth print-access-token`.
- [ ] The two new prefixes hold **empty placeholder objects** (`serial: 1`,
      zero resources, their own lineage) because `terraform init` against a
      new backend prefix writes one. This is expected and they are reused
      below: the carve moves resources *into* the pulled placeholder so
      lineage and serial line up. Inspect before touching them:

      ```sh
      gcloud storage cat gs://<bucket>/terraform/foundation/default.tfstate | jq '{serial, lineage, resources: (.resources|length)}'
      gcloud storage cat gs://<bucket>/terraform/apps/default.tfstate       | jq '{serial, lineage, resources: (.resources|length)}'
      ```

      If `resources` is non-zero, **stop**: something else wrote there.
      Do not delete the objects; a later `init` would only recreate them
      with yet another lineage.

## Variables

```sh
export ENV=staging                       # then production
export BUCKET=onorca-cloud-staging-terraform-state   # onorca-cloud-terraform-state for production
export WORK=/tmp/split-$ENV && mkdir -p $WORK
export GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)"
```

Run every command from the repository root on the merged commit.

## 1. Snapshot (this is the rollback)

```sh
terraform -chdir=infra/terraform init -reconfigure -backend-config=backend/$ENV.hcl -input=false
terraform -chdir=infra/terraform state pull > $WORK/relay-snapshot.tfstate
jq '{serial, lineage, resources: (.resources|length)}' $WORK/relay-snapshot.tfstate
cp $WORK/relay-snapshot.tfstate $WORK/relay.tfstate
```

Record the serial and lineage. Keep `relay-snapshot.tfstate` until PR 9 has
merged.

## 2. Pull the destination placeholders, then carve offline

`terraform state push` refuses a file whose lineage differs from the remote
object, and exits 0 while doing so. So the destination files must *be* the
remote placeholders, pulled after init, not fresh files created by
`state mv -state-out`.

```sh
terraform -chdir=infra/terraform-foundation init -reconfigure -backend-config=backend/$ENV.hcl -input=false
terraform -chdir=infra/terraform-foundation state pull > $WORK/foundation.tfstate
terraform -chdir=infra/terraform-apps       init -reconfigure -backend-config=backend/$ENV.hcl -input=false
terraform -chdir=infra/terraform-apps       state pull > $WORK/apps.tfstate
cp $WORK/foundation.tfstate $WORK/foundation-empty.tfstate && cp $WORK/apps.tfstate $WORK/apps-empty.tfstate
jq '{serial, lineage, resources: (.resources|length)}' $WORK/foundation.tfstate $WORK/apps.tfstate
```

Both must show zero resources. Record both lineages; the pushed files in
step 3 must carry the same ones.

The address lists come from the committed partition; the relay copy loses
every address it moves.

```sh
node dev/scripts/terraform-root-partition.mjs list foundation $ENV > $WORK/foundation.txt
node dev/scripts/terraform-root-partition.mjs list apps       $ENV > $WORK/apps.txt

for family in $(cat $WORK/foundation.txt); do
  terraform state mv -state=$WORK/relay.tfstate -state-out=$WORK/foundation.tfstate "$family" "$family" || echo "skip $family (not in state)"
done
for family in $(cat $WORK/apps.txt); do
  terraform state mv -state=$WORK/relay.tfstate -state-out=$WORK/apps.tfstate "$family" "$family" || echo "skip $family (not in state)"
done
```

A family address moves every `for_each` and `count` instance. Families that
are declared but count-zero in this environment are not in state and are
skipped; that is expected. `state mv` into an existing `-state-out` file
keeps that file's lineage and bumps its serial once per move.

Gate 2a, address census on the three local files:

```sh
terraform state list -state=$WORK/foundation.tfstate > $WORK/foundation-list.txt
terraform state list -state=$WORK/apps.tfstate       > $WORK/apps-list.txt
terraform state list -state=$WORK/relay.tfstate      > $WORK/relay-list.txt
node dev/scripts/terraform-root-partition.mjs audit foundation $ENV $WORK/foundation-list.txt
node dev/scripts/terraform-root-partition.mjs audit apps       $ENV $WORK/apps-list.txt
node dev/scripts/terraform-root-partition.mjs audit relay      $ENV $WORK/relay-list.txt
jq -r .lineage $WORK/foundation.tfstate $WORK/apps.tfstate   # must equal the recorded placeholder lineages
```

All three must print `state matches partition`. Also confirm the counts sum
to the snapshot's resource count (staging keeps its two listed orphans in
the relay file).

## 3. Push the two new states

The roots were initialised in step 2; do not re-run `init` here.

```sh
terraform -chdir=infra/terraform-foundation state push $WORK/foundation.tfstate 2>&1 | tee $WORK/push-foundation.log
terraform -chdir=infra/terraform-apps       state push $WORK/apps.tfstate       2>&1 | tee $WORK/push-apps.log
terraform -chdir=infra/terraform-foundation state pull | jq '{serial, resources: (.resources|length)}'
terraform -chdir=infra/terraform-apps       state pull | jq '{serial, resources: (.resources|length)}'
```

**`terraform state push` exits 0 even when it refuses.** The pull-back is
the only proof: resource counts must match the local files. Any log line
mentioning lineage or serial means the push did not happen. Never add
`-force` to get past a refusal on a non-empty destination.

Gate 3a, plan equivalence on the new roots (read-only):

```sh
node dev/scripts/capture-terraform-plan-baseline.mjs --root infra/terraform-foundation --env $ENV --out $WORK/plans --tag foundation
node dev/scripts/capture-terraform-plan-baseline.mjs --root infra/terraform-apps       --env $ENV --out $WORK/plans --tag apps
```

Compare each `.norm.json` against the single-root baseline captured in PR 1,
restricted to that root's addresses. The slices must be byte-identical: the
same pending changes, no creates for resources that exist, no destroys.

## 4. Push the carved relay state

```sh
jq '{serial, lineage}' $WORK/relay.tfstate      # lineage unchanged; serial = snapshot + number of moves
```

The relay copy keeps the original lineage; `state mv` advanced its serial once
per moved family, so it is far above the snapshot's. **That means the serial
check does not protect this push**: a relay write during the window would
leave the remote serial at snapshot+1, still below the local file, and the
push would overwrite it silently. Verify the remote serial yourself first:

```sh
terraform -chdir=infra/terraform state pull | jq '{serial, lineage}'   # must equal the recorded snapshot values exactly
```

If it has moved, do not push. Re-pull, diff against the snapshot, and restart
from step 1. Only then:

```sh
terraform -chdir=infra/terraform state push $WORK/relay.tfstate 2>&1 | tee $WORK/push-relay.log
terraform -chdir=infra/terraform state pull | jq '{serial, resources: (.resources|length)}'   # must equal $WORK/relay.tfstate
```

Gate 4a, relay equivalence:

```sh
node dev/scripts/capture-terraform-plan-baseline.mjs --root infra/terraform --env $ENV --out $WORK/plans --tag relay
```

Restricted to relay addresses, byte-identical to the PR 1 baseline. This is
the FIRST untargeted relay plan that can succeed in this window: before the
push, one fails with `Error: Cycle` (see Preconditions). After the push the
carved entries are gone from state, so the raw plan lists **no** "will no
longer be managed" lines even though `relay-root-carve-removed.tf` is still
present; a `removed` block for an address that is not in state is a no-op.
`-detailed-exitcode` still returns 2, from the standing drift backlog.

Measured on the pre-surgery state with the carved entries removed, both
environments reproduce their PR 1 relay slice exactly:

| env | `Plan:` line | pure destroys |
| --- | --- | --- |
| production | 64 to add, 58 to change, 47 to destroy | 0 |
| staging | 54 to add, 14 to change, 19 to destroy | 1 (`runtime_artifact_write_secret_accessor[0]`, the known orphan) |

Gate 4b, address census against the live state:

```sh
terraform -chdir=infra/terraform state list > $WORK/relay-live.txt
node dev/scripts/terraform-root-partition.mjs audit relay $ENV $WORK/relay-live.txt
```

## 5. Production-only post-checks

- Exercise the fence broker read-only: it must `terraform init` and read
  `terraform output -json relay_gce_cell_deployments` from the relay root
  cleanly and re-fingerprint the new serial without reporting a completed
  fence.
- Run `Monitor Relay Production` once and confirm it completes.

## Rollback

```sh
terraform -chdir=infra/terraform state push -force $WORK/relay-snapshot.tfstate
terraform -chdir=infra/terraform-foundation state push -force $WORK/foundation-empty.tfstate
terraform -chdir=infra/terraform-apps       state push -force $WORK/apps-empty.tfstate
```

Keep copies of the pulled placeholders from step 2 as
`foundation-empty.tfstate` / `apps-empty.tfstate` before carving, so
rollback returns the new prefixes to zero resources without deleting bucket
objects. `-force` is required only here, because the serials have advanced. Rollback is
safe at any point before PR 9 merges: the `removed` blocks keep the relay
config consistent with either state shape.

## Staging orphans (after the staging push)

Two entries sat in the staging relay state with no config since 2026-08-07
and were carried across unchanged. Handle them right after Gate 4b, staging
only, before PR 10 merges (it removes them from `state_orphans` in
`families.json`, which makes the audit strict again).

1. `data.google_compute_image.relay_gce_cos[0]`: a data source, nothing in
   the cloud. State-only:

   ```sh
   terraform -chdir=infra/terraform state rm 'data.google_compute_image.relay_gce_cos[0]'
   ```

2. `google_secret_manager_secret_iam_member.runtime_artifact_write_secret_accessor[0]`:
   a live grant of `roles/secretmanager.secretAccessor` on
   `orca-artifact-write-token` to the staging api service account. Verified
   2026-09-03 read-only: the live `orca-cloud-api-staging` revision mounts
   only `orca-cloud-skills-database-url`, has no `ORCA_ARTIFACT_WRITE_TOKEN`
   env entry, and `deploy-artifact-api.mjs` strips that legacy entry on every
   deploy. Nothing reads the secret, so **destroy the grant** rather than
   forgetting it and leaving an unowned binding behind. This is the one
   `apply` in this runbook and it is `-target` scoped:

   ```sh
   terraform -chdir=infra/terraform plan -input=false -lock=false \
     -var-file=environments/staging.tfvars \
     -target='google_secret_manager_secret_iam_member.runtime_artifact_write_secret_accessor' \
     -out=$WORK/orphan.tfplan
   # must read exactly: Plan: 0 to add, 0 to change, 1 to destroy.
   terraform -chdir=infra/terraform apply -input=false $WORK/orphan.tfplan
   ```

   The staging data plane does not need to be awake; the target touches no
   cell. If the plan shows anything other than that single destroy, stop.

Re-run Gate 4b afterwards; `state list` must equal the relay partition with
no orphan allowance.

## After both environments

Merge PR 9: it deletes `relay-root-carve-removed.tf`, narrows the shared
deploy identity's counts to production, and drops the two staging-only
bindings the apps root already declares. Until it merges, nobody runs an
untargeted apply on the relay root. Every existing CI workflow is `-target`
scoped and unaffected throughout.

**PR 9 must not merge before both pushes above have landed.** With the
guard gone, an untargeted apply against un-surgered state destroys the
carved resources instead of forgetting them.

## Related

Moving the five staging Relay workflows off the apps-owned deploy account is a
rollout, not state surgery, and has its own document:
[`staging-relay-deploy-identity-rollout.md`](./staging-relay-deploy-identity-rollout.md).
