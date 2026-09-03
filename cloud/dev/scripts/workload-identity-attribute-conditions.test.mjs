import assert from 'node:assert/strict'
import test from 'node:test'

import { renderAttributeConditions } from './render-workload-identity-conditions.mjs'

// GCP rejects an attribute_condition longer than this.
const ATTRIBUTE_CONDITION_LIMIT = 4096

const EXPECTED_CONDITIONS = {
  staging: {
    relay: {
      github_staging_relay_deploy:
        "assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.ref == 'refs/heads/main' && assertion.environment == 'staging' && (assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/bootstrap-relay-staging-capacity.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-staging-gce-candidate.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-staging.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/operate-relay-asia-admission.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/power-relay-staging.yml@refs/heads/main')",
      github_staging_relay_capacity:
        "assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.ref == 'refs/heads/main' && assertion.environment == 'staging' && (assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/bootstrap-relay-staging-capacity.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/prove-relay-staging-capacity.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/recover-relay-staging-c4-image.yml@refs/heads/main')",
      github_relay_asia_topology:
        "assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.ref == 'refs/heads/main' && assertion.environment == 'staging' && assertion.event_name == 'workflow_dispatch' && assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-asia-topology.yml@refs/heads/main'",
      github_relay_asia_proof:
        "assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.ref == 'refs/heads/main' && assertion.environment == 'staging' && assertion.event_name == 'workflow_dispatch' && assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/prove-relay-asia-staging.yml@refs/heads/main'",
    },
  },
  production: {
    relay: {
      github:
        "assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.ref == 'refs/heads/main' && assertion.environment == 'production' && ((assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-fence-broker.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-capacity.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-director.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-multi-target.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/operate-relay-asia-admission.yml@refs/heads/main' || assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/publish-relay-production.yml@refs/heads/main') || (assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/operate-relay-production-rehome.yml@refs/heads/main' && assertion.job_workflow_ref == 'stablyai/orca-cloud/.github/workflows/operate-relay-production-rehome-job.yml@refs/heads/main') || (assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-same-cap.yml@refs/heads/main' && (assertion.job_workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-same-cap-job.yml@refs/heads/main' || assertion.job_workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-same-cap.yml@refs/heads/main')))",
      github_monitor:
        "assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.ref == 'refs/heads/main' && assertion.environment == 'production' && assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/monitor-relay-production.yml@refs/heads/main' && assertion.job_workflow_ref == 'stablyai/orca-cloud/.github/workflows/monitor-relay-production-job.yml@refs/heads/main'",
      github_fence:
        "assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.ref == 'refs/heads/main' && assertion.environment == 'production' && assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-multi-target.yml@refs/heads/main' && assertion.job_workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-multi-target.yml@refs/heads/main'",
      github_production_relay_capacity:
        "assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.ref == 'refs/heads/main' && assertion.environment == 'production' && ((assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-capacity.yml@refs/heads/main' && assertion.job_workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-capacity-job.yml@refs/heads/main') || (assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-same-cap.yml@refs/heads/main' && assertion.job_workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-production-same-cap-job.yml@refs/heads/main'))",
      github_relay_asia_topology:
        "assertion.repository == 'stablyai/orca-cloud' && assertion.repository_id == '1273841466' && assertion.repository_owner_id == '127256420' && assertion.ref == 'refs/heads/main' && assertion.environment == 'production' && assertion.event_name == 'workflow_dispatch' && assertion.workflow_ref == 'stablyai/orca-cloud/.github/workflows/deploy-relay-asia-topology.yml@refs/heads/main'",
    },
  },
}

// [root, provider, condition] for every provider the environment creates, across all roots.
async function flatten(environment) {
  const rendered = await renderAttributeConditions(environment)
  return Object.entries(rendered).flatMap(([root, providers]) =>
    Object.entries(providers).map(([provider, condition]) => [root, provider, condition])
  )
}

for (const [environment, roots] of Object.entries(EXPECTED_CONDITIONS)) {
  test(`${environment} renders the exact reviewed attribute conditions`, async () => {
    const rendered = await renderAttributeConditions(environment)
    assert.deepEqual(Object.keys(rendered).sort(), Object.keys(roots).sort())
    for (const [root, providers] of Object.entries(roots)) {
      assert.deepEqual(Object.keys(rendered[root]).sort(), Object.keys(providers).sort(), root)
      for (const [provider, condition] of Object.entries(providers)) {
        assert.equal(rendered[root][provider], condition, `${environment} ${root} ${provider}`)
      }
    }
  })

  test(`${environment} attribute conditions stay under the GCP length limit`, async () => {
    for (const [root, provider, condition] of await flatten(environment)) {
      assert.ok(
        condition.length < ATTRIBUTE_CONDITION_LIMIT,
        `${environment} ${root} ${provider} is ${condition.length} chars`
      )
    }
  })

  test(`${environment} pins repository, branch, and environment on every provider`, async () => {
    for (const [root, provider, condition] of await flatten(environment)) {
      for (const pin of [
        "assertion.repository == 'stablyai/orca-cloud'",
        "assertion.repository_id == '1273841466'",
        "assertion.repository_owner_id == '127256420'",
        "assertion.ref == 'refs/heads/main'",
        `assertion.environment == '${environment}'`
      ]) {
        assert.ok(condition.includes(pin), `${environment} ${root} ${provider} is missing ${pin}`)
      }
      assert.ok(
        condition.includes('assertion.workflow_ref ==') ||
          condition.includes('assertion.job_workflow_ref =='),
        `${environment} ${root} ${provider} names no workflow`
      )
    }
  })

  // A prefix or suffix match would turn each allowlist into a namespace grant.
  test(`${environment} attribute conditions compare workflows only by equality`, async () => {
    for (const [root, provider, condition] of await flatten(environment)) {
      assert.doesNotMatch(
        condition,
        /startsWith|endsWith|matches|in \[/,
        `${environment} ${root} ${provider}`
      )
    }
  })
}
