// Spot-check the classifier against the load-bearing throws in
// worktree-remote.ts. Not exhaustive — substring widening still requires
// explicit review per the schema-evolution doctrine in
// telemetry-events.ts. Add fixtures here when adding new buckets or when
// a renamed throw site needs regression coverage.

import { describe, expect, it } from 'vitest'
import { formatGitObjectStoreFailureMessage } from '../../shared/git-object-store-failure'
import { classifyWorkspaceCreateError } from './workspace-create-error-classifier'

describe('classifyWorkspaceCreateError', () => {
  it('buckets the missing-base-ref throw as base_ref_missing', () => {
    const err = new Error(
      'Could not resolve a default base ref for this repo. Pick a base branch explicitly and try again.'
    )
    expect(classifyWorkspaceCreateError(err)).toBe('base_ref_missing')
  })

  it('buckets a branch-already-exists throw as path_collision', () => {
    const err = new Error('Branch "feature/foo" already exists. Pick a different branch name.')
    expect(classifyWorkspaceCreateError(err)).toBe('path_collision')
  })

  it('buckets the suffix-exhaustion throw as path_collision', () => {
    const err = new Error(
      'Could not find an available worktree name for "feature". Pick a different worktree name.'
    )
    expect(classifyWorkspaceCreateError(err)).toBe('path_collision')
  })

  it('buckets a branch-already-exists-locally throw as path_collision', () => {
    const err = new Error(
      'Branch "feature/foo" already exists locally. Pick a different branch name.'
    )
    expect(classifyWorkspaceCreateError(err)).toBe('path_collision')
  })

  it('buckets an existing-PR collision throw as path_collision', () => {
    const err = new Error('Branch "feature/foo" already has PR #42. Pick a different branch name.')
    expect(classifyWorkspaceCreateError(err)).toBe('path_collision')
  })

  it('buckets the post-create listing-miss throw as git_failed', () => {
    const err = new Error('Worktree created but not found in listing')
    expect(classifyWorkspaceCreateError(err)).toBe('git_failed')
  })

  it('buckets EACCES errors as permission_denied', () => {
    const err = Object.assign(new Error("EACCES: permission denied, mkdir '/tmp/x'"), {
      code: 'EACCES'
    })
    expect(classifyWorkspaceCreateError(err)).toBe('permission_denied')
  })

  it('buckets generic git errors as git_failed', () => {
    const err = new Error('fatal: not a git repository')
    expect(classifyWorkspaceCreateError(err)).toBe('git_failed')
  })

  it('keeps a redacted object-store failure in git_failed', () => {
    // The redacted message drops 'fatal:' and the argv, so it needs its own anchor.
    const err = new Error(
      formatGitObjectStoreFailureMessage({
        failure: { kind: 'unreadable-tree', oid: '041335168f0214913840aaaaaaaaaaaaaaaaaaaa' },
        branch: 'akulafb/test',
        commit: 'present',
        rootTree: 'missing',
        partialClone: 'no'
      })
    )
    expect(err.message).not.toContain('fatal:')
    expect(classifyWorkspaceCreateError(err)).toBe('git_failed')
  })

  it('keeps a redacted permission failure in permission_denied, not git_failed', () => {
    // Real git 2.44 for a tree object at mode 000: the keyword only exists in the raw text.
    const raw = new Error(
      "Command failed: git worktree add /Users/akulafb/dev/worktrees/test 'akulafb/test'\n" +
        'error: unable to open loose object ba856f78f34fcefae5d72ef4aec60e70a52ea4a0: Permission denied\n' +
        'fatal: unable to read tree c34d8d3a1ebd165bbdc29303e8c0e7330442abaa'
    )
    expect(classifyWorkspaceCreateError(raw)).toBe('permission_denied')

    const described = new Error(
      formatGitObjectStoreFailureMessage({
        failure: { kind: 'unreadable-tree', oid: 'c34d8d3a1ebd165bbdc29303e8c0e7330442abaa' },
        branch: 'akulafb/test',
        commit: 'present',
        rootTree: 'unverifiable',
        partialClone: 'no'
      })
    )
    described.cause = raw

    expect(described.message.toLowerCase()).not.toContain('permission denied')
    expect(classifyWorkspaceCreateError(described)).toBe('permission_denied')
  })

  it("reads the cause's stderr when a buffer cap truncated its message", () => {
    const raw = Object.assign(new Error('git timed out.'), {
      stderr: 'error: unable to open loose object ba856f78: Permission denied\n'
    })
    const described = new Error(
      formatGitObjectStoreFailureMessage({
        failure: { kind: 'unreadable-tree', oid: null },
        branch: 'akulafb/test',
        commit: 'unverifiable',
        rootTree: 'unverifiable',
        partialClone: 'unverifiable'
      })
    )
    described.cause = raw

    expect(classifyWorkspaceCreateError(described)).toBe('permission_denied')
  })

  it('falls through to unknown for unrecognised errors', () => {
    const err = new Error('something completely unexpected')
    expect(classifyWorkspaceCreateError(err)).toBe('unknown')
  })

  it('falls through to unknown for SSH-precondition errors', () => {
    const err = new Error('SSH connection is not available. Please reconnect and try again.')
    expect(classifyWorkspaceCreateError(err)).toBe('unknown')
  })

  it('handles non-Error values without throwing', () => {
    expect(classifyWorkspaceCreateError('a bare string')).toBe('unknown')
    expect(classifyWorkspaceCreateError(undefined)).toBe('unknown')
    expect(classifyWorkspaceCreateError(null)).toBe('unknown')
  })
})
