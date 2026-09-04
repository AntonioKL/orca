import { describe, expect, it } from 'vitest'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  getExecutionHostLabel,
  getRepoExecutionHostId,
  resolveRepoExecutionHostId
} from './execution-host'
import type { Repo } from './repo-types'
import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost
} from './worktree-execution-host-resolution'

// `executionHostId` is a template-literal type, so `ssh:${string}` admits ids the parser rejects:
// an empty target, a pipe (the worktree-host-identity delimiter), a broken percent escape, and a
// scheme a future build might publish.
const UNPARSEABLE_HOST_IDS = ['ssh:', 'ssh:a|b', 'ssh:%zz', 'runtime:', 'quantum:box'] as const

function repoRow(overrides: Partial<Repo> = {}): Repo {
  return { id: 'repo-1', path: '/work/repo-1', displayName: 'repo-1', ...overrides } as Repo
}

describe('resolveRepoExecutionHostId', () => {
  it('answers null where the total reading answers local', () => {
    for (const executionHostId of UNPARSEABLE_HOST_IDS) {
      const repo = repoRow({ executionHostId: executionHostId as Repo['executionHostId'] })
      expect(resolveRepoExecutionHostId(repo)).toBeNull()
      // The total reading is deliberately unchanged: ~340 grouping, label and index callers only
      // need a bucket, and this is the split that keeps them off the strict path.
      expect(getRepoExecutionHostId(repo)).toBe(LOCAL_EXECUTION_HOST_ID)
    }
  })

  it('does not recover a host from the connectionId the row overrode', () => {
    const repo = repoRow({
      executionHostId: 'ssh:a|b' as Repo['executionHostId'],
      connectionId: 'build-box'
    })
    expect(resolveRepoExecutionHostId(repo)).toBeNull()
  })

  it('agrees with the total reading for every row that names a parseable host', () => {
    const rows = [
      repoRow(),
      repoRow({ connectionId: 'build-box' }),
      repoRow({ executionHostId: 'ssh:build-box' }),
      repoRow({ executionHostId: 'runtime:env-1' }),
      repoRow({ executionHostId: 'local', connectionId: 'build-box' })
    ]
    for (const repo of rows) {
      expect(resolveRepoExecutionHostId(repo)).toBe(getRepoExecutionHostId(repo))
    }
  })
})

describe('worktree host resolution over such a row', () => {
  const malformed = repoRow({ executionHostId: 'ssh:a|b' as Repo['executionHostId'] })

  it('answers `malformed`, which is distinct from `unknown`', () => {
    expect(
      resolveWorktreeExecutionHost(createRepoRowExecutionHostLookup([malformed]), {
        repoId: 'repo-1',
        hostId: null
      })
    ).toEqual({ kind: 'unresolved', reason: 'malformed' })
    // Nothing carries this id at all — the other unresolved reason, which callers may dispose of as
    // a plain local folder.
    expect(
      resolveWorktreeExecutionHost(createRepoRowExecutionHostLookup([malformed]), {
        repoId: 'absent',
        hostId: null
      })
    ).toEqual({ kind: 'unresolved', reason: 'unknown' })
  })

  it('matches no host in the row lookup', () => {
    const lookup = createRepoRowExecutionHostLookup([malformed])
    expect(lookup.byHost('repo-1', LOCAL_EXECUTION_HOST_ID)).toBeNull()
    expect(lookup.byHost('repo-1', 'ssh:build-box')).toBeNull()
  })
})

describe('getExecutionHostLabel', () => {
  it('labels an unparseable id as one unknown host, not as every host', () => {
    expect(getExecutionHostLabel('ssh:a|b')).toBe('Unknown host')
    expect(getExecutionHostLabel(null)).toBe('Unknown host')
    expect(getExecutionHostLabel(ALL_EXECUTION_HOSTS_SCOPE)).toBe('All hosts')
    expect(getExecutionHostLabel('ssh:build-box')).toBe('build-box')
  })
})
