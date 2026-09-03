import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { Project, ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import { readProfileState, rebuildRepoBackedProjectState } from './profile-project-state-file'

const upstreamIdentity = {
  canonicalKey: 'git.example.com/acme/app-upstream',
  remoteName: 'upstream',
  remoteUrl: 'git@git.example.com:acme/app-upstream.git'
}

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'App',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  displayName: 'App',
  badgeColor: '#737373',
  sourceRepoIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const makeSetup = (overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup => ({
  id: 'setup-1',
  projectId: 'project-1',
  hostId: 'local',
  repoId: '',
  path: '/repo',
  displayName: 'App',
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

function makeState(overrides: Partial<PersistedState>): PersistedState {
  return { ...getDefaultPersistedState('/home/test'), ...overrides }
}

describe('rebuildRepoBackedProjectState', () => {
  it('carries project state and independent setups across a repo remote identity change', () => {
    const originProjectId = 'git:git.example.com/acme/app'
    const rebuilt = rebuildRepoBackedProjectState(
      makeState({
        repos: [makeRepo({ gitRemoteIdentity: upstreamIdentity })],
        projects: [
          makeProject({
            id: originProjectId,
            sourceRepoIds: ['r1'],
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
          })
        ],
        projectHostSetups: [
          makeSetup({ id: 'r1', projectId: originProjectId, repoId: 'r1' }),
          makeSetup({
            id: 'app::gpu-vm',
            projectId: originProjectId,
            hostId: 'runtime:gpu-vm',
            path: '/srv/app'
          })
        ]
      })
    )

    expect(rebuilt.projects).toEqual([
      expect.objectContaining({
        id: 'git:git.example.com/acme/app-upstream',
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      })
    ])
    expect(rebuilt.projectHostSetups.find((setup) => setup.id === 'app::gpu-vm')?.projectId).toBe(
      'git:git.example.com/acme/app-upstream'
    )
  })

  it('picks one predecessor project when several prior rows overlap the same repos', () => {
    const sharedIdentity = {
      canonicalKey: 'git.example.com/acme/shared',
      remoteName: 'origin',
      remoteUrl: 'git@git.example.com:acme/shared.git'
    }
    const rebuilt = rebuildRepoBackedProjectState(
      makeState({
        repos: [
          makeRepo({ id: 'r1', path: '/left', gitRemoteIdentity: sharedIdentity }),
          makeRepo({ id: 'r2', path: '/right', gitRemoteIdentity: sharedIdentity })
        ],
        projects: [
          makeProject({
            id: 'git:git.example.com/acme/left',
            sourceRepoIds: ['r1'],
            updatedAt: 200,
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
          }),
          makeProject({
            id: 'git:git.example.com/acme/right',
            sourceRepoIds: ['r2'],
            updatedAt: 100,
            localWindowsRuntimePreference: { kind: 'windows-host' }
          })
        ],
        projectHostSetups: [
          makeSetup({ id: 'r1', projectId: 'git:git.example.com/acme/left', repoId: 'r1' }),
          makeSetup({ id: 'r2', projectId: 'git:git.example.com/acme/right', repoId: 'r2' })
        ]
      })
    )

    // Equal repo overlap resolves by newest updatedAt; the loser's preference is never merged in.
    expect(rebuilt.projects).toEqual([
      expect.objectContaining({
        id: 'git:git.example.com/acme/shared',
        sourceRepoIds: ['r1', 'r2'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      })
    ])
  })

  it('leaves an unclaimed prior project standing with its own independent setups', () => {
    const rebuilt = rebuildRepoBackedProjectState(
      makeState({
        repos: [makeRepo({ gitRemoteIdentity: upstreamIdentity })],
        projects: [
          makeProject({
            id: 'cloud-project',
            localWindowsRuntimePreference: { kind: 'windows-host' }
          })
        ],
        projectHostSetups: [
          makeSetup({ id: 'cloud-project::gpu-vm', projectId: 'cloud-project', path: '/srv/cloud' })
        ]
      })
    )

    expect(rebuilt.projects.map((project) => project.id)).toEqual([
      'git:git.example.com/acme/app-upstream',
      'cloud-project'
    ])
    expect(rebuilt.projectHostSetups.map((setup) => setup.projectId)).toEqual([
      'git:git.example.com/acme/app-upstream',
      'cloud-project'
    ])
  })
})

/**
 * A profile transfer reads another profile's file directly, bypassing the Store's load path. The
 * serializer omits any `worktreeMeta` row the identity map can rebuild, so without the rebuild here
 * every transferred workspace would arrive at the target profile stripped of its metadata.
 */
describe('readProfileState on a projected profile file', () => {
  function seedProfile(state: unknown): { userDataPath: string; profileId: string } {
    const userDataPath = realpathSync(mkdtempSync(join(tmpdir(), 'orca-profile-read-')))
    const profileId = 'source'
    mkdirSync(join(userDataPath, 'profiles', profileId), { recursive: true })
    writeFileSync(
      join(userDataPath, 'profiles', profileId, 'orca-data.json'),
      JSON.stringify(state),
      'utf-8'
    )
    return { userDataPath, profileId }
  }

  const identityRow = {
    hostId: 'local',
    instanceId: 'inst-1',
    displayName: 'projected workspace',
    linkedPR: 41
  }

  it('rebuilds the locator rows the serializer left to the identity map', () => {
    const { userDataPath, profileId } = seedProfile({
      repos: [makeRepo({ id: 'repo', path: '/repo' })],
      worktreeMeta: {},
      worktreeMetaByIdentity: { 'wt2:local:inst-1': identityRow },
      worktreeIdentityAliases: { 'local|repo::/projected': ['wt2:local:inst-1'] },
      worktreeMetaAliasesWithoutLegacyRow: []
    })

    const state = readProfileState(profileId, userDataPath)

    expect(state.worktreeMeta['repo::/projected']).toEqual(identityRow)
    // Serialize-only: it must never be carried into the state a transfer writes back.
    expect(state.worktreeMetaAliasesWithoutLegacyRow).toBeUndefined()
  })

  it('leaves a genuinely removed locator removed', () => {
    const { userDataPath, profileId } = seedProfile({
      repos: [makeRepo({ id: 'repo', path: '/repo' })],
      worktreeMeta: {},
      worktreeMetaByIdentity: { 'wt2:local:inst-1': identityRow },
      worktreeIdentityAliases: { 'local|repo::/projected': ['wt2:local:inst-1'] },
      worktreeMetaAliasesWithoutLegacyRow: ['local|repo::/projected']
    })

    expect(readProfileState(profileId, userDataPath).worktreeMeta).toEqual({})
  })
})
