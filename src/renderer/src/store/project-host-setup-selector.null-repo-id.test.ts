import { describe, expect, it } from 'vitest'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { getProjectHostSetupProjectionFromState } from './project-host-setup-selector'

// Crash 3bcc5be3 (v1.4.188, page.settings boundary): a hydrated setup row whose
// repoId arrived as null reached Settings' projectByRepoId useMemo and threw
// "Cannot read properties of null (reading 'trim')" while opening Settings.
const repos = [
  {
    id: 'repo-1',
    path: '/Users/alice/orca',
    displayName: 'orca',
    kind: 'git'
  } as unknown as Repo
]

const projects: Project[] = [
  {
    id: 'project-1',
    displayName: 'Project',
    badgeColor: '#737373',
    sourceRepoIds: ['repo-1'],
    createdAt: 1,
    updatedAt: 1
  } as unknown as Project
]

function makeSetups(repoId: unknown): ProjectHostSetup[] {
  return [
    {
      id: 'setup-1',
      projectId: 'project-1',
      hostId: 'local',
      repoId,
      path: '/Users/alice/orca',
      displayName: 'orca',
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 1,
      updatedAt: 1
    } as unknown as ProjectHostSetup
  ]
}

function projectionFor(repoId: unknown) {
  return getProjectHostSetupProjectionFromState({
    repos,
    projects,
    projectHostSetups: makeSetups(repoId)
  })
}

// Mirrors the Settings.tsx projectByRepoId useMemo that crashed.
function buildProjectByRepoIdLikeSettings(
  setups: readonly ProjectHostSetup[],
  projectList: readonly Project[]
): Map<string, Project> {
  const projectById = new Map(projectList.map((project) => [project.id, project]))
  const nextProjectByRepoId = new Map<string, Project>()
  for (const setup of setups) {
    const project = projectById.get(setup.projectId)
    if (project && setup.repoId.trim()) {
      nextProjectByRepoId.set(setup.repoId, project)
    }
  }
  return nextProjectByRepoId
}

describe('project host setup projection with a non-string repoId', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42]
  ])('coerces a %s repoId to an empty string', (_label, repoId) => {
    const hydrated = projectionFor(repoId).setups.find((setup) => setup.id === 'setup-1')
    expect(hydrated).toBeDefined()
    expect(hydrated?.repoId).toBe('')
  })

  it('lets the Settings projectByRepoId memo run instead of throwing on .trim()', () => {
    const projection = projectionFor(null)
    expect(() =>
      buildProjectByRepoIdLikeSettings(projection.setups, projection.projects)
    ).not.toThrow()
    // Why: an empty repoId is not an openable repo row, so it must not be indexed.
    expect(buildProjectByRepoIdLikeSettings(projection.setups, projection.projects).has('')).toBe(
      false
    )
  })

  it('leaves a real repoId untouched and still indexes it', () => {
    const projection = projectionFor('repo-1')
    const hydrated = projection.setups.find((setup) => setup.id === 'setup-1')
    expect(hydrated?.repoId).toBe('repo-1')
    expect([
      ...buildProjectByRepoIdLikeSettings(projection.setups, projection.projects).keys()
    ]).toEqual(['repo-1'])
  })

  it('keeps the projection reference-stable for a repeated input', () => {
    const setups = makeSetups(null)
    const args = { repos, projects, projectHostSetups: setups }
    expect(getProjectHostSetupProjectionFromState(args)).toBe(
      getProjectHostSetupProjectionFromState(args)
    )
  })
})
