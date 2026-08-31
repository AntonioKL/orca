// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SidebarHeader from './SidebarHeader'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  openWorkspaceCreationComposerWithTourHandoff: vi.fn()
}))

type MockState = {
  repos: { id: string }[]
  groupBy: string
  sidebarBody: 'workspaces' | 'agents'
  setSidebarBody: (body: 'workspaces' | 'agents') => void
  openModal: (modal: string, data?: unknown) => void
}

let mockState: MockState

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockState) => unknown) => selector(mockState)
}))

vi.mock('@/components/dashboard/useAgentBucketCounts', () => ({
  useAgentBucketCounts: () => ({ attention: 0, working: 0, done: 0, idle: 0 })
}))

vi.mock('./SidebarWorkspaceOptionsMenu', () => ({ default: () => null }))

vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => '⌘N' }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('../contextual-tours/workspace-creation-tour-handoff', () => ({
  openWorkspaceCreationComposerWithTourHandoff: mocks.openWorkspaceCreationComposerWithTourHandoff
}))

let container: HTMLDivElement
let root: Root

function newWorkspaceButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[aria-label="New workspace"]')
  if (!button) {
    throw new Error('New workspace button not rendered')
  }
  return button
}

beforeEach(() => {
  mocks.openWorkspaceCreationComposerWithTourHandoff.mockClear()
  mockState = {
    repos: [],
    groupBy: 'repo',
    sidebarBody: 'workspaces',
    setSidebarBody: vi.fn(),
    openModal: vi.fn()
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SidebarHeader', () => {
  it('keeps New workspace clickable with zero projects, since the composer adds the first one', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    const button = newWorkspaceButton()
    expect(button.disabled).toBe(false)

    act(() => {
      button.click()
    })

    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).toHaveBeenCalledTimes(1)
  })

  it('opens the composer the same way once projects exist', () => {
    mockState.repos = [{ id: 'repo-a' }]
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    act(() => {
      newWorkspaceButton().click()
    })

    expect(newWorkspaceButton().disabled).toBe(false)
    expect(mocks.openWorkspaceCreationComposerWithTourHandoff).toHaveBeenCalledTimes(1)
  })

  it('switches sidebar body to agents when clicking the agents tab in workspaces mode', () => {
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    const agentTab = container.querySelector<HTMLButtonElement>(
      'button[data-sidebar-section-title="agents"]'
    )
    expect(agentTab).toBeTruthy()

    act(() => {
      agentTab?.click()
    })

    expect(mockState.setSidebarBody).toHaveBeenCalledWith('agents')
  })

  it('switches sidebar body to workspaces when clicking the projects tab in agents mode', () => {
    mockState.sidebarBody = 'agents'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    const projectsTab = container.querySelector<HTMLButtonElement>(
      'button[data-sidebar-section-title="projects"]'
    )
    expect(projectsTab).toBeTruthy()

    act(() => {
      projectsTab?.click()
    })

    expect(mockState.setSidebarBody).toHaveBeenCalledWith('workspaces')
  })

  it('does not render workspace action buttons in agents mode', () => {
    mockState.sidebarBody = 'agents'
    act(() => {
      root.render(<SidebarHeader onWorkspaceBoardMenuOpenChange={vi.fn()} />)
    })

    expect(container.querySelector('[aria-label="New workspace"]')).toBeNull()
    expect(container.querySelector('[aria-label="Add Project"]')).toBeNull()
  })
})
