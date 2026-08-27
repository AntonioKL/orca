import { describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { normalizeLoadedProjectCatalog } from './normalize-loaded-state-collections'

function makeParsed(setups: unknown[], projects: unknown[] = []): PersistedState {
  return { projects, projectHostSetups: setups } as unknown as PersistedState
}

const badSetup = {
  id: 'setup-1',
  projectId: 'project-1',
  hostId: 'local',
  repoId: null,
  path: null,
  displayName: 'orca',
  setupState: 'ready',
  setupMethod: 'legacy-repo',
  createdAt: 1,
  updatedAt: 1
}

describe('normalizeLoadedProjectCatalog', () => {
  it('repairs stored rows whose field types do not match the declared ones', () => {
    const result = normalizeLoadedProjectCatalog(makeParsed([{ ...badSetup }]), vi.fn())
    expect(result.projectHostSetups[0]?.repoId).toBe('')
    expect(result.projectHostSetups[0]?.path).toBe('')
  })

  // Why: without a save the bad rows stay on disk, get repaired again every launch, and this
  // host keeps publishing them to paired clients. Marking dirty is the migration.
  it('marks the profile dirty so the repair is persisted', () => {
    const markNeedsSave = vi.fn()
    normalizeLoadedProjectCatalog(makeParsed([{ ...badSetup }]), markNeedsSave)
    expect(markNeedsSave).toHaveBeenCalled()
  })

  it('leaves a conforming catalog untouched and does not schedule a save', () => {
    const markNeedsSave = vi.fn()
    const setups = [{ ...badSetup, repoId: 'repo-1', path: '/repo' }]
    const parsed = makeParsed(setups)
    const result = normalizeLoadedProjectCatalog(parsed, markNeedsSave)
    expect(result.projectHostSetups).toBe(setups)
    expect(markNeedsSave).not.toHaveBeenCalled()
  })

  it('tolerates missing or non-array collections', () => {
    const result = normalizeLoadedProjectCatalog({} as PersistedState, vi.fn())
    expect(result.projects).toEqual([])
    expect(result.projectHostSetups).toEqual([])
  })
})
