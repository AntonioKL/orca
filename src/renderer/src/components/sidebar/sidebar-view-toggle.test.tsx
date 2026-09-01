// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SidebarViewToggle } from './sidebar-view-toggle'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SidebarViewToggle', () => {
  it('sizes the track to its labels so they stay fully visible', () => {
    act(() => {
      root.render(
        <SidebarViewToggle
          ariaLabel="Sidebar view"
          value="workspaces"
          onSelect={() => undefined}
          options={[
            {
              value: 'workspaces',
              label: 'Projects',
              widthLabels: ['Workspaces', 'Projects'],
              sectionTitle: 'projects'
            },
            { value: 'agents', label: 'Agents', sectionTitle: 'agents' }
          ]}
        />
      )
    })

    const group = container.querySelector('[role="radiogroup"]')
    const groupClasses = new Set(group?.className.split(/\s+/) ?? [])
    expect(groupClasses.has('inline-flex')).toBe(true)
    expect(groupClasses.has('shrink-0')).toBe(true)
    expect(groupClasses.has('flex-1')).toBe(false)

    const projectsTab = container.querySelector('[data-sidebar-section-title="projects"]')
    const visibleLabel = [...(projectsTab?.querySelectorAll('span') ?? [])].find(
      (span) => span.getAttribute('aria-hidden') == null && span.textContent === 'Projects'
    )
    expect(visibleLabel?.className).toContain('whitespace-nowrap')
    expect(visibleLabel?.className.includes('truncate')).toBe(false)
  })

  it('renders the unread badge only for a positive badgeCount', () => {
    act(() => {
      root.render(
        <SidebarViewToggle
          ariaLabel="Sidebar view"
          value="workspaces"
          onSelect={() => undefined}
          options={[
            { value: 'workspaces', label: 'Projects', sectionTitle: 'projects', badgeCount: 0 },
            { value: 'agents', label: 'Agents', sectionTitle: 'agents', badgeCount: 5 }
          ]}
        />
      )
    })

    const agentsTab = container.querySelector('[data-sidebar-section-title="agents"]')
    expect(agentsTab?.textContent).toContain('5')
    const projectsTab = container.querySelector('[data-sidebar-section-title="projects"]')
    expect(projectsTab?.textContent).toBe('ProjectsProjects')
  })
})
