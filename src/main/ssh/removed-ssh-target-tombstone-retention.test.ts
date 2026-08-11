import { describe, expect, it } from 'vitest'
import {
  capRemovedSshTargetTombstones,
  collectAutomationReferencedSshTargetIds
} from './removed-ssh-target-tombstone-retention'
import type { RemovedSshTargetTombstone } from '../../shared/ssh-types'

function tombstones(count: number): RemovedSshTargetTombstone[] {
  return Array.from({ length: count }, (_, index) => ({
    oldTargetId: `ssh-${index}`,
    host: 'h',
    port: 22,
    username: 'u',
    label: `Host ${index}`,
    removedAt: index
  }))
}

describe('capRemovedSshTargetTombstones', () => {
  it('drops the oldest unreferenced records first', () => {
    const capped = capRemovedSshTargetTombstones(tombstones(5), new Set(), 3)
    expect(capped.map((entry) => entry.oldTargetId)).toEqual(['ssh-2', 'ssh-3', 'ssh-4'])
  })

  it('retains referenced removal evidence past the cap', () => {
    const capped = capRemovedSshTargetTombstones(tombstones(5), new Set(['ssh-0']), 3)
    expect(capped.map((entry) => entry.oldTargetId)).toEqual(['ssh-0', 'ssh-3', 'ssh-4'])
  })

  it('keeps everything when every record is still referenced', () => {
    const all = tombstones(5)
    const referenced = new Set(all.map((entry) => entry.oldTargetId))
    expect(capRemovedSshTargetTombstones(all, referenced, 2)).toHaveLength(5)
  })
})

describe('collectAutomationReferencedSshTargetIds', () => {
  it('collects only non-empty SSH selectors', () => {
    expect(
      collectAutomationReferencedSshTargetIds([
        { executionTargetType: 'ssh', executionTargetId: 'ssh-1' },
        { executionTargetType: 'ssh', executionTargetId: '' },
        { executionTargetType: 'local', executionTargetId: 'local' }
      ])
    ).toEqual(new Set(['ssh-1']))
  })
})
