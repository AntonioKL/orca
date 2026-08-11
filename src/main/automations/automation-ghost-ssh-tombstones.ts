import type { Automation } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import type { RemovedSshTargetTombstone } from '../../shared/ssh-types'
import {
  capRemovedSshTargetTombstones,
  collectAutomationReferencedSshTargetIds
} from '../ssh/removed-ssh-target-tombstone-retention'

/**
 * Positive removal evidence for SSH targets that only a stored automation still
 * references. Legacy state has no tombstone for a target removed before repos
 * pointed at it, so the ghost host would be invisible — including on a freshly
 * paired client with no list cache. Synthesizing a bounded tombstone puts the
 * last known label into the mirrored `removedTargetLabels` map instead.
 *
 * The synthetic record carries no host/port/username, so it is stamped
 * `origin: 'automation-scan'` and the re-adoption matcher refuses to match it on
 * the identity tuple — a ghost can never steal a real, unrelated new target.
 */

/** SSH target ids referenced by an automation but absent from the target registry. */
export function collectMissingAutomationSshTargetIds(
  automations: readonly Automation[],
  sshTargets: readonly { id: string }[]
): Set<string> {
  const known = new Set(sshTargets.map((target) => target.id))
  const missing = new Set<string>()
  for (const targetId of collectAutomationReferencedSshTargetIds(automations)) {
    if (!known.has(targetId)) {
      missing.add(targetId)
    }
  }
  return missing
}

// Label precedence per the design: existing tombstone, else the owning repo, else the raw id.
function ghostLabel(targetId: string, repos: readonly Repo[]): string {
  const owningRepo = repos.find((repo) => repo.connectionId === targetId)
  return owningRepo?.displayName?.trim() || targetId
}

export type GhostSshTombstoneScanResult = {
  removedSshTargetTombstones: RemovedSshTargetTombstone[]
  changed: boolean
}

/**
 * Add a synthetic tombstone for every automation-referenced SSH target that has
 * neither a live registration nor an existing tombstone. Idempotent: a second
 * pass finds the tombstones it wrote and changes nothing.
 */
export function scanAutomationsForGhostSshTargets(input: {
  automations: readonly Automation[]
  sshTargets: readonly { id: string }[]
  repos: readonly Repo[]
  removedSshTargetTombstones: readonly RemovedSshTargetTombstone[]
  now: number
}): GhostSshTombstoneScanResult {
  const existing = new Set(input.removedSshTargetTombstones.map((entry) => entry.oldTargetId))
  const added: RemovedSshTargetTombstone[] = []
  for (const targetId of collectMissingAutomationSshTargetIds(
    input.automations,
    input.sshTargets
  )) {
    if (existing.has(targetId)) {
      continue
    }
    added.push({
      oldTargetId: targetId,
      host: '',
      port: 0,
      username: '',
      label: ghostLabel(targetId, input.repos),
      removedAt: input.now,
      origin: 'automation-scan'
    })
  }
  if (added.length === 0) {
    return {
      removedSshTargetTombstones: [...input.removedSshTargetTombstones],
      changed: false
    }
  }
  return {
    removedSshTargetTombstones: capRemovedSshTargetTombstones(
      [...input.removedSshTargetTombstones, ...added],
      collectAutomationReferencedSshTargetIds(input.automations)
    ),
    changed: true
  }
}
