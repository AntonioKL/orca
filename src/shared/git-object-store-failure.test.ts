import { describe, expect, it } from 'vitest'
import {
  GIT_OBJECT_STORE_FAILURE_ANCHOR,
  GIT_OBJECT_STORE_REPAIR_GUIDANCE,
  classifyGitObjectStoreFailure,
  formatGitObjectStoreFailureMessage,
  isGitSilentNegativeAnswer
} from './git-object-store-failure'

// Verbatim field report (1.4.187 / macOS), path redacted the way the reporter redacted it.
const FIELD_STDERR =
  "Command failed: git worktree add /Users/akulafb/dev/worktrees/test 'akulafb/test'\n" +
  "Preparing worktree (checking out 'akulafb/test')\n" +
  'fatal: unable to read tree (041335168f0214913840aaaaaaaaaaaaaaaaaaaa)'

describe('classifyGitObjectStoreFailure', () => {
  it('classifies the reported parenthesised unreadable-tree fatal and keeps the oid', () => {
    expect(classifyGitObjectStoreFailure(FIELD_STDERR)).toEqual({
      kind: 'unreadable-tree',
      oid: '041335168f0214913840aaaaaaaaaaaaaaaaaaaa'
    })
  })

  it('classifies the unparenthesised form emitted by other Git versions', () => {
    expect(
      classifyGitObjectStoreFailure(
        'fatal: unable to read tree 6d4882f90c4c5154793d3e4ec49968a42f87005f'
      )
    ).toEqual({ kind: 'unreadable-tree', oid: '6d4882f90c4c5154793d3e4ec49968a42f87005f' })
  })

  it('classifies missing blobs, corrupt loose objects and empty object files', () => {
    expect(
      classifyGitObjectStoreFailure(
        "error: missing blob object 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'"
      )
    ).toEqual({ kind: 'missing-object', oid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
    expect(
      classifyGitObjectStoreFailure('error: object file .git/objects/ab/cd is empty')?.kind
    ).toBe('corrupt-object')
    expect(
      classifyGitObjectStoreFailure(
        'error: loose object abcd1234 (stored in .git/objects/ab/cd) is corrupt'
      )?.kind
    ).toBe('corrupt-object')
  })

  // Verbatim `git checkout` stderr on git 2.44.0 when the branch's root tree is deleted:
  // the sparse-create path dies here, not in `worktree add --no-checkout`, which exits 0.
  it('classifies the checkout-side wording the sparse create path dies on', () => {
    expect(
      classifyGitObjectStoreFailure(
        'Command failed: git checkout akulafb/test\nfatal: unable to parse commit 435b1d6c622920a72b8984ec55742106c5434436'
      )
    ).toEqual({
      kind: 'unparsable-commit',
      oid: '435b1d6c622920a72b8984ec55742106c5434436'
    })
  })

  it('does not claim an object-store failure for unrelated git errors', () => {
    expect(classifyGitObjectStoreFailure('fatal: not a git repository')).toBeNull()
    expect(
      classifyGitObjectStoreFailure("fatal: 'wt' already exists and is not an empty directory")
    ).toBeNull()
    expect(classifyGitObjectStoreFailure('')).toBeNull()
  })
})

describe('formatGitObjectStoreFailureMessage', () => {
  const failure = classifyGitObjectStoreFailure(FIELD_STDERR)!

  it('never leaks the local path or the argv that failed', () => {
    const message = formatGitObjectStoreFailureMessage({
      failure,
      branch: 'akulafb/test',
      commit: 'present',
      rootTree: 'missing',
      partialClone: 'no'
    })

    expect(message).not.toContain('/Users/akulafb')
    expect(message).not.toContain('Command failed')
    expect(message).not.toContain('git worktree add')
    expect(message).toContain(GIT_OBJECT_STORE_FAILURE_ANCHOR)
    expect(message).toContain('akulafb/test')
    expect(message).toContain('git fsck')
  })

  it('only claims the root tree is missing when the probe actually observed it', () => {
    const unverifiable = formatGitObjectStoreFailureMessage({
      failure,
      branch: 'akulafb/test',
      commit: 'unverifiable',
      rootTree: 'unverifiable',
      partialClone: 'unverifiable'
    })

    expect(unverifiable).not.toContain('root tree object is missing')
    expect(unverifiable).not.toContain('partial clone')
    expect(unverifiable).toContain(GIT_OBJECT_STORE_FAILURE_ANCHOR)
  })

  it('recommends a refetch when a promisor remote was actually observed', () => {
    const partial = formatGitObjectStoreFailureMessage({
      failure,
      branch: 'akulafb/test',
      commit: 'present',
      rootTree: 'missing',
      partialClone: 'yes'
    })

    expect(partial).toContain('partial clone')
    expect(partial).toContain('git fetch')
  })

  it('does not claim the commit survived when the commit probe did not observe it', () => {
    // Real git 2.44 on a repo with an emptied commit object: `^{commit}` and `^{tree}`
    // both exit 1, so a bare tree peel proves nothing about the tree.
    const message = formatGitObjectStoreFailureMessage({
      failure,
      branch: 'akulafb/test',
      commit: 'missing',
      rootTree: 'missing',
      partialClone: 'no'
    })

    expect(message).not.toContain('root tree object is missing')
    expect(message).not.toContain('is present but')
    expect(message).toContain('Git could not read every object')
  })

  it('claims the commit-present/tree-missing shape only when both probes observed it', () => {
    const message = formatGitObjectStoreFailureMessage({
      failure,
      branch: 'akulafb/test',
      commit: 'present',
      rootTree: 'missing',
      partialClone: 'no'
    })

    expect(message).toContain('root tree object is missing')
  })

  it('does not blanket-exonerate Orca, which runs `git worktree prune` and leaves auto-gc on', () => {
    // src/main/git/worktree.ts, local-worktree-removal-recovery.ts, orca-runtime.ts and
    // relay/git-handler-worktree-remove.ts all run `worktree prune`; auto-maintenance is
    // suppressed for exactly one fetch, so Orca cannot promise nothing of its doing ran.
    expect(GIT_OBJECT_STORE_REPAIR_GUIDANCE).not.toMatch(/never runs/i)
    expect(GIT_OBJECT_STORE_REPAIR_GUIDANCE).not.toMatch(/nothing in orca/i)
    expect(GIT_OBJECT_STORE_REPAIR_GUIDANCE).not.toMatch(/prune/i)
    expect(GIT_OBJECT_STORE_REPAIR_GUIDANCE).toContain('git fsck')
  })
})

describe('isGitSilentNegativeAnswer', () => {
  it('accepts only a wordless status 1', () => {
    expect(isGitSilentNegativeAnswer(1, '')).toBe(true)
    expect(isGitSilentNegativeAnswer(1, 'Command failed: git rev-parse --verify --quiet x')).toBe(
      true
    )
  })

  it('rejects a status 1 Git explained, so unreadable never reads as absent', () => {
    expect(
      isGitSilentNegativeAnswer(
        1,
        'error: unable to open loose object ba856f78f34fcefae5d72ef4aec60e70a52ea4a0: Permission denied'
      )
    ).toBe(false)
    // Git 2.38 answers the same truncated object with 128 rather than 1.
    expect(isGitSilentNegativeAnswer(128, '')).toBe(false)
  })

  it('rejects an error that carries no exit status at all', () => {
    expect(isGitSilentNegativeAnswer(undefined, '')).toBe(false)
    expect(isGitSilentNegativeAnswer('ENOENT', '')).toBe(false)
  })
})
