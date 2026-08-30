/**
 * STA-4846: the terminal workbench is bare-workspace-id keyed end to end
 * (`activeWorktreeId`, `tabsByWorktree`, `mountedWorktreeIdsRef`, React keys),
 * but its catalog inputs are host-qualified — `getIndexedAllWorktrees` emits one
 * row per (host, id) and `mergeFetchedFolderWorkspacesForHost` keeps one folder
 * row per (host, id). A repo checked out at the same path locally and on an
 * SSH/paired-runtime host therefore reached the mount loops twice, mounting the
 * same tabIds under duplicate React keys with both trees marked visible.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectWorkspaceSurfaces } from './workspace-surface-projection'
import { getIndexedWorktreeMap } from '../store/worktree-repo-index'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Worktree } from '../../../shared/worktree/types'

const SHARED_WORKTREE_ID = 'repo-shared::/work/orca-feature'

// A production collision differs only by host: `worktreeId` is `repoId::path`,
// so both rows necessarily carry the same repoId and path (see STA-4343's
// sidebar/worktree-list-groups-host-collision.test.ts).
const localWorktree: Worktree = {
  id: SHARED_WORKTREE_ID,
  repoId: 'repo-shared',
  path: '/work/orca-feature',
  hostId: 'local',
  head: 'abc123',
  branch: 'feature',
  isBare: false,
  isMainWorktree: false,
  displayName: 'orca-feature',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}
const sshWorktree: Worktree = { ...localWorktree, hostId: 'ssh:build-box' }

const localFolder: FolderWorkspace = {
  id: 'folder-shared',
  projectGroupId: 'group-shared',
  name: 'orca',
  folderPath: '/work/orca-local',
  executionHostId: 'local',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}
const runtimeFolder: FolderWorkspace = {
  ...localFolder,
  folderPath: '/remote/orca',
  executionHostId: 'runtime:env-1'
}

function project(input: {
  worktrees?: readonly Worktree[]
  folderWorkspaces?: readonly FolderWorkspace[]
  activeWorkspaceId?: string | null
  activeWorkspaceResolvedHostId?: ExecutionHostId | null
}): ReturnType<typeof projectWorkspaceSurfaces> {
  return projectWorkspaceSurfaces({
    // Built through the production index so the test pins the composition the
    // workbench actually runs, not a re-implementation of the per-id collapse.
    worktreesById: getIndexedWorktreeMap({ 'repo-shared': [...(input.worktrees ?? [])] }),
    folderWorkspaces: input.folderWorkspaces ?? [],
    activeWorkspaceId: input.activeWorkspaceId ?? null,
    activeWorkspaceResolvedHostId: input.activeWorkspaceResolvedHostId ?? null
  })
}

describe('projectWorkspaceSurfaces', () => {
  it('emits one surface per workspace id when two hosts publish the same worktree', () => {
    const surfaces = project({ worktrees: [localWorktree, sshWorktree] })

    expect(surfaces).toEqual([{ id: SHARED_WORKTREE_ID, path: '/work/orca-feature' }])
  })

  it('never emits a duplicate id, so mount loops cannot reuse a React key', () => {
    const surfaces = project({
      worktrees: [localWorktree, sshWorktree],
      folderWorkspaces: [localFolder, runtimeFolder]
    })

    expect(new Set(surfaces.map((surface) => surface.id)).size).toBe(surfaces.length)
  })

  it('emits one surface per folder workspace id across hosts', () => {
    const surfaces = project({ folderWorkspaces: [localFolder, runtimeFolder] })

    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]?.id).toBe('folder:folder-shared')
  })

  it('mounts the active folder workspace at its resolved host path, not the first row', () => {
    const surfaces = project({
      folderWorkspaces: [localFolder, runtimeFolder],
      activeWorkspaceId: 'folder:folder-shared',
      activeWorkspaceResolvedHostId: 'runtime:env-1'
    })

    expect(surfaces).toEqual([{ id: 'folder:folder-shared', path: '/remote/orca' }])
  })

  it('keeps the first row when no resolved host disambiguates the folder collision', () => {
    const surfaces = project({ folderWorkspaces: [runtimeFolder, localFolder] })

    expect(surfaces).toEqual([{ id: 'folder:folder-shared', path: '/remote/orca' }])
  })

  it('switches the active folder path from first-wins to the host that hydrates', () => {
    // Ownership resolves to null while the folder-owner index still reads the
    // colliding id as ambiguous, so the projection first-wins until it lands.
    const folderWorkspaces = [localFolder, runtimeFolder]
    const hydrating = project({
      folderWorkspaces,
      activeWorkspaceId: 'folder:folder-shared',
      activeWorkspaceResolvedHostId: null
    })
    const hydrated = project({
      folderWorkspaces,
      activeWorkspaceId: 'folder:folder-shared',
      activeWorkspaceResolvedHostId: 'runtime:env-1'
    })

    expect(hydrating).toEqual([{ id: 'folder:folder-shared', path: '/work/orca-local' }])
    expect(hydrated).toEqual([{ id: 'folder:folder-shared', path: '/remote/orca' }])
    // The id is what mounts; only the path moves, so the transition is no remount.
    expect(hydrated[0]?.id).toBe(hydrating[0]?.id)
  })

  it('keeps the surviving host row when a runtime disconnect drops its peer', () => {
    // Loss of contact with the runtime must not unmount the workspace: the
    // mount prune drops ids that leave the projection.
    const surfaces = project({ worktrees: [localWorktree] })

    expect(surfaces).toEqual([{ id: SHARED_WORKTREE_ID, path: '/work/orca-feature' }])
  })

  it('keeps distinct workspaces on one host', () => {
    const otherWorktree: Worktree = {
      ...localWorktree,
      id: 'repo-shared::/work/orca-other',
      path: '/work/orca-other'
    }

    expect(project({ worktrees: [localWorktree, otherWorktree] })).toEqual([
      { id: SHARED_WORKTREE_ID, path: '/work/orca-feature' },
      { id: 'repo-shared::/work/orca-other', path: '/work/orca-other' }
    ])
  })
})

// Why source text: the per-id collapse lives in the store index, so the module
// tests above stay green even if Terminal.tsx goes back to flattening the
// host-qualified array itself. The feed is the half that has to be ratcheted.
describe('Terminal workbench surface feed', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/Terminal.tsx'),
    'utf8'
  )

  it('feeds the projection from the store per-id index, never the host-qualified array', () => {
    expect(source).not.toContain('useAllWorktrees')
    expect(source).toContain('const worktreesById = useWorktreeMap()')
  })

  it('has exactly one projection call site, so no second flatten can hide beside it', () => {
    expect(
      source.split('projectWorkspaceSurfaces(').length - 1,
      'expected exactly one projectWorkspaceSurfaces call in Terminal.tsx'
    ).toBe(1)
    expect(source).toContain('worktreesById,\n        folderWorkspaces,')
  })
})
