// @vitest-environment happy-dom

/**
 * A tab strip with no tabs shows only the "+", and no terminal can be focused
 * to lift the strip out of its `-webkit-app-region: drag` state (issue #18024),
 * so the strip itself has to opt out while it is empty.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { ConfirmationDialogContext } from '../confirmation-dialog-context'
import TabGroupSplitLayout from './TabGroupSplitLayout'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Why: the real list module pulls in runtime IPC; the strip under test needs no files.
vi.mock('../quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => ({
    files: [],
    loading: false,
    loadError: null,
    truncated: false
  })
}))

const CONFIRM_STUB = async (): Promise<boolean> => true
const WORKTREE_ID = 'wt-1'
const GROUP_ID = 'group-1'

const worktree = {
  id: WORKTREE_ID,
  repoId: 'repo-1',
  path: '/tmp/wt-1',
  head: 'abc123',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: false,
  displayName: 'Aurora',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
} satisfies Worktree

const unifiedTab: Tab = {
  id: 'tab-a',
  entityId: 'term-a',
  groupId: GROUP_ID,
  worktreeId: WORKTREE_ID,
  contentType: 'terminal',
  label: '',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

const terminalTab: TerminalTab = {
  id: 'term-a',
  ptyId: null,
  worktreeId: WORKTREE_ID,
  title: 'alpha',
  generatedTitle: null,
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}

function seed({ withTab }: { withTab: boolean }): void {
  const group: TabGroup = {
    id: GROUP_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: withTab ? unifiedTab.id : null,
    tabOrder: withTab ? [unifiedTab.id] : []
  }
  useAppStore.setState(
    {
      ...useAppStore.getInitialState(),
      worktreesByRepo: { 'repo-1': [worktree] },
      unifiedTabsByWorktree: { [WORKTREE_ID]: withTab ? [unifiedTab] : [] },
      tabsByWorktree: { [WORKTREE_ID]: withTab ? [terminalTab] : [] },
      groupsByWorktree: { [WORKTREE_ID]: [group] },
      layoutByWorktree: { [WORKTREE_ID]: { type: 'leaf', groupId: GROUP_ID } },
      activeGroupIdByWorktree: { [WORKTREE_ID]: GROUP_ID },
      activeWorktreeId: WORKTREE_ID
    } as AppState,
    true
  )
}

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
})

function renderStrip(): HTMLElement {
  act(() => {
    root.render(
      <ConfirmationDialogContext.Provider value={CONFIRM_STUB}>
        <TooltipProvider>
          <TabGroupSplitLayout
            layout={{ type: 'leaf', groupId: GROUP_ID }}
            worktreeId={WORKTREE_ID}
            focusedGroupId={GROUP_ID}
            isWorktreeActive={true}
          />
        </TooltipProvider>
      </ConfirmationDialogContext.Provider>
    )
  })
  const strip = container.querySelector<HTMLElement>(`[data-tab-group-strip-id="${GROUP_ID}"]`)
  if (!strip) {
    throw new Error('tab group strip not rendered')
  }
  return strip
}

describe('tab group strip drag region', () => {
  it('opts out of the window drag region when the group has no tabs', () => {
    seed({ withTab: false })
    const strip = renderStrip()
    expect(container.querySelector('button[aria-label="New tab"]')).not.toBeNull()
    expect(strip.getAttribute('data-tab-strip-empty')).toBe('true')
  })

  it('stays draggable while the group has a tab', () => {
    seed({ withTab: true })
    expect(renderStrip().hasAttribute('data-tab-strip-empty')).toBe(false)
  })
})
