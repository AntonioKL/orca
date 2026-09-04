import { describe, expect, it } from 'vitest'
import type { Repo } from '../shared/repo-types'
import {
  requireRepoExecutionHostId,
  UnresolvableExecutionHostError
} from './providers/execution-host-provider-dispatch'
import { resolveWorkspaceCleanupRepoGitRoute } from './ipc/workspace-cleanup-git-route'
import { getRepoHostedReviewExecutionHostId } from './source-control/hosted-review-execution-host'
import { resolveWorktreeHostRouting } from './runtime/worktree-launch-host-repo'

// #11163's remaining layer. A repo row whose `executionHostId` is present but unparseable resolved
// to `local` ABOVE the host-keyed dispatch, so `UnresolvableExecutionHostError` could never fire on
// a repo row — the collapse happened before dispatch was ever asked.
const MALFORMED: Repo = {
  id: 'repo-1',
  path: '/work/repo-1',
  displayName: 'repo-1',
  executionHostId: 'ssh:a|b' as Repo['executionHostId']
} as Repo

const HEALTHY: Repo = { ...MALFORMED, executionHostId: 'ssh:build-box' }

describe('dispatch for a repo row with an unresolvable execution host', () => {
  it('throws from requireRepoExecutionHostId', () => {
    expect(() => requireRepoExecutionHostId(MALFORMED)).toThrow(UnresolvableExecutionHostError)
    expect(requireRepoExecutionHostId(HEALTHY)).toBe('ssh:build-box')
  })

  it('throws from the workspace-cleanup git route instead of scanning this machine', () => {
    expect(() => resolveWorkspaceCleanupRepoGitRoute(MALFORMED)).toThrow(
      UnresolvableExecutionHostError
    )
    expect(resolveWorkspaceCleanupRepoGitRoute(HEALTHY)).toMatchObject({
      kind: 'ssh',
      connectionId: 'build-box'
    })
  })

  it('throws from the hosted-review host instead of running git and the forge CLI here', () => {
    expect(() => getRepoHostedReviewExecutionHostId(MALFORMED)).toThrow(
      UnresolvableExecutionHostError
    )
    expect(getRepoHostedReviewExecutionHostId(HEALTHY)).toBe('ssh:build-box')
  })

  it('routes a worktree on the row to `ambiguous`, not the `unowned` verdict callers read as local', () => {
    expect(resolveWorktreeHostRouting([MALFORMED], { repoId: 'repo-1', hostId: null })).toEqual({
      kind: 'ambiguous'
    })
    // An id nothing carries stays `unowned`, which the launch path resolves as a plain local folder.
    expect(resolveWorktreeHostRouting([MALFORMED], { repoId: 'absent', hostId: null })).toEqual({
      kind: 'unowned'
    })
  })
})
