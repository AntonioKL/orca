import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateWorktreeArgs } from '../../shared/worktree/create-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { Worktree } from '../../shared/worktree/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { recordWorkspaceLineageForCreatedWorktree } from './worktree-remote'

const CHILD_ID = 'repo-1::/repos/child'
const PARENT_ID = 'repo-1::/repos/parent'
const CREATED_AT = 1_700_000_000_000

function createdWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: CHILD_ID,
    instanceId: 'child-instance',
    repoId: 'repo-1',
    hostId: 'local',
    projectId: 'project-1',
    path: '/repos/child',
    head: 'abc123',
    branch: 'refs/heads/child',
    isBare: false,
    isMainWorktree: false,
    displayName: 'child',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function parentMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    instanceId: 'parent-instance',
    hostId: 'local',
    projectId: 'project-1',
    displayName: 'parent',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function createStore(options: {
  metaById?: Record<string, WorktreeMeta>
  folderWorkspaceIds?: string[]
}) {
  const metaById = options.metaById ?? {}
  const folderWorkspaceIds = new Set(options.folderWorkspaceIds ?? [])
  return {
    getWorktreeMeta: vi.fn((id: string) => metaById[id]),
    getFolderWorkspace: vi.fn((id: string) =>
      folderWorkspaceIds.has(id) ? { id, path: `/folders/${id}` } : undefined
    ),
    setWorktreeLineage: vi.fn((_id: string, lineage: unknown) => lineage),
    setWorkspaceLineage: vi.fn((lineage: unknown) => lineage)
  }
}

function record(
  store: ReturnType<typeof createStore>,
  args: Partial<CreateWorktreeArgs>,
  worktree = createdWorktree()
) {
  return recordWorkspaceLineageForCreatedWorktree(
    store as never,
    args as CreateWorktreeArgs,
    worktree,
    CREATED_AT
  )
}

describe('recordWorkspaceLineageForCreatedWorktree', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes both lineage rows for a worktree parent inside the same repo/host/project', () => {
    const store = createStore({ metaById: { [PARENT_ID]: parentMeta() } })

    const result = record(store, { parentWorkspace: worktreeWorkspaceKey(PARENT_ID) })

    expect(store.setWorktreeLineage).toHaveBeenCalledWith(CHILD_ID, {
      worktreeId: CHILD_ID,
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: PARENT_ID,
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: CREATED_AT
    })
    expect(result.lineage).toMatchObject({
      parentWorktreeId: PARENT_ID,
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' }
    })
    expect(result.workspaceLineage).toEqual({
      childWorkspaceKey: worktreeWorkspaceKey(CHILD_ID),
      childInstanceId: 'child-instance',
      parentWorkspaceKey: worktreeWorkspaceKey(PARENT_ID),
      parentInstanceId: 'parent-instance',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: CREATED_AT
    })
  })

  it('skips both lineage records when the parent belongs to a different repo', () => {
    const foreignParentId = 'repo-2::/repos/parent'
    const store = createStore({ metaById: { [foreignParentId]: parentMeta() } })

    const result = record(store, { parentWorkspace: worktreeWorkspaceKey(foreignParentId) })

    expect(store.setWorktreeLineage).not.toHaveBeenCalled()
    expect(result.lineage).toBeNull()
    expect(store.setWorkspaceLineage).not.toHaveBeenCalled()
    expect(result.workspaceLineage).toBeNull()
  })

  it.each([
    ['host', parentMeta({ hostId: 'ssh:other-host' })],
    ['project', parentMeta({ projectId: 'project-2' })]
  ])(
    'skips both lineage records when the parent %s conflicts, so no cross-host row is persisted',
    (_label, meta) => {
      const store = createStore({ metaById: { [PARENT_ID]: meta } })

      const result = record(store, { parentWorkspace: worktreeWorkspaceKey(PARENT_ID) })

      expect(store.setWorktreeLineage).not.toHaveBeenCalled()
      expect(result.lineage).toBeNull()
      // A persisted cross-host row makes filterLineageForHost return null for the entire host.
      expect(store.setWorkspaceLineage).not.toHaveBeenCalled()
      expect(result.workspaceLineage).toBeNull()
    }
  )

  it('skips worktree lineage when the parent has no instance identity', () => {
    const store = createStore({ metaById: { [PARENT_ID]: parentMeta({ instanceId: undefined }) } })

    const result = record(store, { parentWorkspace: worktreeWorkspaceKey(PARENT_ID) })

    expect(store.setWorktreeLineage).not.toHaveBeenCalled()
    expect(result.lineage).toBeNull()
    expect(result.workspaceLineage).toMatchObject({
      parentWorkspaceKey: worktreeWorkspaceKey(PARENT_ID),
      parentInstanceId: null
    })
  })

  it('records only workspace lineage for a folder-workspace parent', () => {
    const store = createStore({ folderWorkspaceIds: ['folder-1'] })

    const result = record(store, { parentWorkspace: folderWorkspaceKey('folder-1') })

    expect(store.setWorktreeLineage).not.toHaveBeenCalled()
    expect(result.lineage).toBeNull()
    expect(result.workspaceLineage).toMatchObject({
      parentWorkspaceKey: folderWorkspaceKey('folder-1'),
      parentInstanceId: null,
      capture: { source: 'active-workspace', confidence: 'explicit' }
    })
  })

  it('records nothing without a parent workspace', () => {
    const store = createStore({})

    const result = record(store, {})

    expect(store.setWorktreeLineage).not.toHaveBeenCalled()
    expect(store.setWorkspaceLineage).not.toHaveBeenCalled()
    expect(result).toEqual({ lineage: null, workspaceLineage: null })
  })

  it('records nothing when the parent workspace is the created worktree itself', () => {
    const store = createStore({ metaById: { [CHILD_ID]: parentMeta() } })

    const result = record(store, { parentWorkspace: worktreeWorkspaceKey(CHILD_ID) })

    expect(store.setWorktreeLineage).not.toHaveBeenCalled()
    expect(store.setWorkspaceLineage).not.toHaveBeenCalled()
    expect(result).toEqual({ lineage: null, workspaceLineage: null })
  })

  it('records nothing when the parent worktree disappeared before the write', () => {
    const store = createStore({})

    const result = record(store, { parentWorkspace: worktreeWorkspaceKey(PARENT_ID) })

    expect(store.setWorkspaceLineage).not.toHaveBeenCalled()
    expect(result).toEqual({ lineage: null, workspaceLineage: null })
  })
})
