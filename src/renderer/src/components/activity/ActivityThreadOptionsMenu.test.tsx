// @vitest-environment happy-dom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { ActivityThreadOptionsMenu } from './ActivityPrototypePage'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function Harness({
  groupBy,
  onGroupByChange,
  compactMode = false,
  hasUnreadThreads = true
}: {
  groupBy?: 'status' | 'project' | 'worktree' | 'agent'
  onGroupByChange?: (groupBy: 'status' | 'project' | 'worktree' | 'agent') => void
  compactMode?: boolean
  hasUnreadThreads?: boolean
}): ReactElement {
  return (
    <TooltipProvider>
      <ActivityThreadOptionsMenu
        groupBy={groupBy}
        onGroupByChange={onGroupByChange}
        compactMode={compactMode}
        hasUnreadThreads={hasUnreadThreads}
        onCompactModeChange={vi.fn()}
        onMarkAllThreadsRead={vi.fn()}
      />
    </TooltipProvider>
  )
}

describe('ActivityThreadOptionsMenu', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.replaceChildren()
  })

  it('opens without recursively updating composed Radix trigger refs', async () => {
    await act(async () => {
      root.render(<Harness />)
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Thread list options"]'
    )

    expect(trigger).not.toBeNull()
    expect(trigger?.parentElement?.tagName).toBe('SPAN')

    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })

    expect(document.body.textContent).toContain('Compact mode')
  })

  it('renders group by options when provided', async () => {
    const onGroupByChange = vi.fn()
    await act(async () => {
      root.render(<Harness groupBy="status" onGroupByChange={onGroupByChange} />)
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Thread list options"]'
    )

    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })

    expect(document.body.textContent).toContain('Group agent activity by')
    expect(document.body.textContent).toContain('Status')
    expect(document.body.textContent).toContain('Project')
    expect(document.body.textContent).toContain('Worktree')
    expect(document.body.textContent).toContain('Agent')
  })
})
