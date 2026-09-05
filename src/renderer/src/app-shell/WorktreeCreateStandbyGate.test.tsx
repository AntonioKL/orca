// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { getDefaultSettings } from '../../../shared/constants'
import type { AppState } from '../store/types'
import type { Repo } from '../../../shared/repo-types'

const mocks = vi.hoisted(() => ({ web: false, setStandby: vi.fn() }))
vi.mock('../store', () => ({ useAppStore: create<AppState>(() => ({}) as AppState) }))
vi.mock('../lib/web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
import { useAppStore } from '../store'
import { WorktreeCreateStandbyGate } from './WorktreeCreateStandbyGate'
import { resetInputQuietSchedulerForTest } from '../lib/input-quiet-scheduler'

const repo = { id: 'one', path: '/one' } as Repo
const second = { id: 'two', path: '/two' } as Repo
function visible(value: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: value ? 'visible' : 'hidden'
  })
  act(() => document.dispatchEvent(new Event('visibilitychange')))
}
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_100)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  resetInputQuietSchedulerForTest()
  mocks.web = false
  mocks.setStandby.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { worktrees: { setCreateStandby: mocks.setStandby } }
  })
  visible(true)
  useAppStore.setState({
    repos: [repo, second],
    projects: [],
    activeRepoId: repo.id,
    settings: null,
    newWorkspaceDraft: null,
    workspaceHostScope: 'all'
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('prepares only the latest target after rapid switches', async () => {
  render(<WorktreeCreateStandbyGate enabled />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000)
  })
  act(() => useAppStore.setState({ activeRepoId: second.id }))
  await settle()
  expect(mocks.setStandby.mock.calls).toEqual([[{ repoId: second.id }]])
})

it('cancels pending work while hidden and releases a prepared target on unmount', async () => {
  const view = render(<WorktreeCreateStandbyGate enabled />)
  visible(false)
  await settle()
  expect(mocks.setStandby).not.toHaveBeenCalled()
  visible(true)
  await settle()
  expect(mocks.setStandby).toHaveBeenLastCalledWith({ repoId: repo.id })
  view.unmount()
  expect(mocks.setStandby).toHaveBeenLastCalledWith({ repoId: null })
})

it('releases when hidden and does not refill from unrelated state updates', async () => {
  render(<WorktreeCreateStandbyGate enabled />)
  await settle()
  act(() => useAppStore.setState({ repos: [{ ...repo }, { ...second }] }))
  await settle()
  expect(mocks.setStandby).toHaveBeenCalledTimes(1)
  visible(false)
  expect(mocks.setStandby).toHaveBeenLastCalledWith({ repoId: null })
})

it.each([
  { ...repo, connectionId: 'ssh' },
  { ...repo, kind: 'folder' },
  { ...repo, executionHostId: 'runtime:remote' },
  { ...repo, executionHostId: 'ssh:remote' }
])('does not prepare an ineligible owner or folder', async (target) => {
  useAppStore.setState({ repos: [target as Repo] })
  render(<WorktreeCreateStandbyGate enabled />)
  await settle()
  expect(mocks.setStandby).not.toHaveBeenCalled()
})

it('honors explicit local ownership while another runtime is focused', async () => {
  useAppStore.setState({
    repos: [{ ...repo, executionHostId: 'local' }],
    settings: { activeRuntimeEnvironmentId: 'remote' } as AppState['settings']
  })
  render(<WorktreeCreateStandbyGate enabled />)
  await settle()
  expect(mocks.setStandby).toHaveBeenCalledWith({ repoId: repo.id })
})

it('does not route an unowned legacy repo through a focused runtime', async () => {
  useAppStore.setState({
    settings: { activeRuntimeEnvironmentId: 'remote' } as AppState['settings']
  })
  render(<WorktreeCreateStandbyGate enabled />)
  await settle()
  expect(mocks.setStandby).not.toHaveBeenCalled()
})

it('matches the persisted composer draft repo and base', async () => {
  useAppStore.setState({
    newWorkspaceDraft: { repoId: second.id, baseBranch: 'release' } as AppState['newWorkspaceDraft']
  })
  render(<WorktreeCreateStandbyGate enabled />)
  await settle()
  expect(mocks.setStandby).toHaveBeenCalledWith({ repoId: second.id, baseBranch: 'release' })
})

it.each(['web', 'missing', 'disabled'])('does nothing when unavailable: %s', async (reason) => {
  mocks.web = reason === 'web'
  if (reason === 'missing') {
    delete window.api.worktrees.setCreateStandby
  }
  render(<WorktreeCreateStandbyGate enabled={reason !== 'disabled'} />)
  await settle()
  expect(mocks.setStandby).not.toHaveBeenCalled()
})

it('waits for input quiet before preparing', async () => {
  render(<WorktreeCreateStandbyGate enabled />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_500)
  })
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' })))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000)
  })
  expect(mocks.setStandby).not.toHaveBeenCalled()
  await settle()
  expect(mocks.setStandby).toHaveBeenCalledExactlyOnceWith({ repoId: repo.id })
})

it('releases the old target before preparing the next', async () => {
  render(<WorktreeCreateStandbyGate enabled />)
  await settle()
  act(() => useAppStore.setState({ activeRepoId: second.id }))
  expect(mocks.setStandby).toHaveBeenLastCalledWith({ repoId: null })
  await settle()
  expect(mocks.setStandby.mock.calls).toEqual([
    [{ repoId: repo.id }],
    [{ repoId: null }],
    [{ repoId: second.id }]
  ])
})

it('cancels a scheduled preparation on unmount', async () => {
  const view = render(<WorktreeCreateStandbyGate enabled />)
  view.unmount()
  await settle()
  expect(mocks.setStandby).not.toHaveBeenCalled()
})

it.each(['workspaceDir', 'nestWorkspaces', 'localWindowsRuntimeDefault'] as const)(
  'releases and re-arms when placement/runtime setting changes: %s',
  async (key) => {
    const settings = getDefaultSettings('/tmp')
    useAppStore.setState({ settings })
    render(<WorktreeCreateStandbyGate enabled />)
    await settle()
    act(() =>
      useAppStore.setState({
        settings: {
          ...settings,
          [key]:
            key === 'workspaceDir'
              ? '/new-root'
              : key === 'nestWorkspaces'
                ? !settings.nestWorkspaces
                : { kind: 'wsl', distro: 'Ubuntu' }
        } as AppState['settings']
      })
    )
    expect(mocks.setStandby).toHaveBeenLastCalledWith({ repoId: null })
    await settle()
    expect(mocks.setStandby).toHaveBeenLastCalledWith({ repoId: repo.id })
  }
)

it('re-arms for the selected project runtime and repo placement, ignoring another project', async () => {
  const project = { id: 'project', sourceRepoIds: [repo.id] } as AppState['projects'][number]
  useAppStore.setState({ projects: [project] })
  render(<WorktreeCreateStandbyGate enabled />)
  await settle()
  act(() =>
    useAppStore.setState({
      projects: [
        project,
        {
          id: 'other',
          sourceRepoIds: [second.id],
          localWindowsRuntimePreference: { kind: 'windows-host' }
        } as AppState['projects'][number]
      ]
    })
  )
  await settle()
  expect(mocks.setStandby).toHaveBeenCalledTimes(1)
  act(() =>
    useAppStore.setState({
      projects: [{ ...project, localWindowsRuntimePreference: { kind: 'windows-host' } }]
    })
  )
  expect(mocks.setStandby).toHaveBeenLastCalledWith({ repoId: null })
  await settle()
  act(() => useAppStore.setState({ repos: [{ ...repo, worktreeBasePath: '/new-root' }] }))
  expect(mocks.setStandby).toHaveBeenLastCalledWith({ repoId: null })
  await settle()
  expect(mocks.setStandby).toHaveBeenCalledTimes(5)
})

it('ignores unrelated settings and terminal state churn', async () => {
  render(<WorktreeCreateStandbyGate enabled />)
  await settle()
  act(() =>
    useAppStore.setState({
      settings: { theme: 'dark' } as AppState['settings'],
      activeWorktreeId: 'other-workspace'
    })
  )
  await settle()
  expect(mocks.setStandby).toHaveBeenCalledTimes(1)
})
