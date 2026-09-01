// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ActivityThreadListPane } from './activity-thread-list-pane'
import type { ActivityThreadGroup, AgentPaneThread } from './activity-thread-types'
import { makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const THREAD_COUNT = 300

function makeThread(index: number): AgentPaneThread {
  return {
    paneKey: `tab-${index}:leaf-${index}`,
    tab: makeTab(),
    worktree: makeWorktree(),
    repo: null,
    currentAgentState: null,
    currentAgentEntry: null,
    latestEvent: null,
    latestTimestamp: 1_000_000 - index,
    agentType: 'claude',
    unread: false,
    paneTitle: `Virtual agent ${index}`,
    responsePreview: '',
    events: []
  }
}

function makeManyThreads(): AgentPaneThread[] {
  return Array.from({ length: THREAD_COUNT }, (_, index) => makeThread(index))
}

function makeGroups(threads: AgentPaneThread[]): ActivityThreadGroup[] {
  return [{ key: 'done', label: 'Done', state: 'done', threads }]
}

function renderPane(
  root: Root,
  args: {
    threads: AgentPaneThread[]
    selectedPaneKey?: string | null
  }
): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <ActivityThreadListPane
          activityFilterInputRef={{ current: null }}
          query=""
          onQueryChange={vi.fn()}
          groupBy="status"
          onGroupByChange={vi.fn()}
          readFilter="all"
          onReadFilterChange={vi.fn()}
          compactMode={true}
          hasUnreadThreads={false}
          onCompactModeChange={vi.fn()}
          onMarkAllThreadsRead={vi.fn()}
          visibleThreadGroups={makeGroups(args.threads)}
          visibleThreadCount={args.threads.length}
          selectedPaneKey={args.selectedPaneKey ?? null}
          onSelectThread={vi.fn()}
          onJumpToWorkspace={vi.fn()}
          onMarkThreadUnread={vi.fn()}
          canJumpToWorkspace={() => true}
          showFilterControls={false}
          showOptionsMenu={false}
        />
      </TooltipProvider>
    )
  })
}

describe('ActivityThreadListPane virtualization', () => {
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

  function mountedRowCount(): number {
    return container.querySelectorAll('[data-worktree-card-surface="true"]').length
  }

  it('mounts a viewport-bounded number of rows, not one per thread', () => {
    renderPane(root, { threads: makeManyThreads() })
    const mounted = mountedRowCount()
    expect(mounted).toBeGreaterThan(0)
    // Viewport (600px fallback) / ~96px rows + 2x overscan(8); far below THREAD_COUNT.
    expect(mounted).toBeLessThanOrEqual(40)
    // Off-screen rows are not in the DOM at all.
    expect(container.textContent).not.toContain('Virtual agent 250')
  })

  it('keeps the selected off-screen row mounted so activation stays accessible', () => {
    renderPane(root, {
      threads: makeManyThreads(),
      selectedPaneKey: 'tab-250:leaf-250'
    })
    const selected = container.querySelector('[data-worktree-card-active="primary"]')
    expect(selected).not.toBeNull()
    expect(selected?.textContent).toContain('Virtual agent 250')
    // Still virtualized: pinning the selection must not mount the rest of the list.
    expect(mountedRowCount()).toBeLessThanOrEqual(41)
  })

  it('does not mount an off-screen row when its thread data updates', () => {
    const threads = makeManyThreads()
    renderPane(root, { threads })
    const before = mountedRowCount()

    const updated = [...threads]
    updated[250] = { ...threads[250], paneTitle: 'Virtual agent 250 UPDATED', unread: true }
    renderPane(root, { threads: updated })

    expect(container.textContent).not.toContain('Virtual agent 250 UPDATED')
    expect(mountedRowCount()).toBe(before)
  })

  it('renders every row for a short list', () => {
    renderPane(root, { threads: [makeThread(0), makeThread(1), makeThread(2)] })
    expect(mountedRowCount()).toBe(3)
    expect(container.textContent).toContain('Virtual agent 0')
    expect(container.textContent).toContain('Virtual agent 2')
  })
})
