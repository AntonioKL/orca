import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { normalizeWorkspaceSessionPaneIdentities } from './workspace-pane-normalization'

const { registerPaneKeyAliasMock } = vi.hoisted(() => ({
  registerPaneKeyAliasMock: vi.fn()
}))

vi.mock('../../agent-hooks/server', () => ({
  agentHookServer: {
    registerPaneKeyAlias: registerPaneKeyAliasMock
  }
}))

const STABLE_LEAF_ID = '00000000-0000-4000-8000-000000000001'

function terminalTab(id: string, worktreeId: string, ptyId: string | null): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function workspaceSession(
  tabsByWorktree: Record<string, TerminalTab[]>,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree,
    terminalLayoutsByTabId
  }
}

function legacyLayout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: 'pane:1' },
    activeLeafId: 'pane:1',
    expandedLeafId: null
  }
}

function stableLayout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: STABLE_LEAF_ID },
    activeLeafId: STABLE_LEAF_ID,
    expandedLeafId: null
  }
}

describe('workspace pane normalization tab index', () => {
  beforeEach(() => {
    registerPaneKeyAliasMock.mockReset()
  })

  it('keeps the first tab when duplicate ids occur across worktrees', () => {
    const result = normalizeWorkspaceSessionPaneIdentities(
      workspaceSession(
        {
          first: [terminalTab('duplicate-tab', 'first', 'first-pty')],
          second: [terminalTab('duplicate-tab', 'second', 'second-pty')]
        },
        { 'duplicate-tab': legacyLayout() }
      )
    )

    expect(result.legacyPaneKeyAliasEntries).not.toHaveLength(0)
    expect(result.legacyPaneKeyAliasEntries.every((entry) => entry.ptyId === 'first-pty')).toBe(
      true
    )
  })

  it('keeps missing tab ids without inventing persisted aliases', () => {
    const result = normalizeWorkspaceSessionPaneIdentities(
      workspaceSession({}, { 'missing-tab': legacyLayout() })
    )

    expect(result.legacyPaneKeyAliasEntries).toEqual([])
  })

  it('reads each tab id once regardless of the number of layouts', () => {
    const tabCount = 256
    let idReads = 0
    const tabs = Array.from({ length: tabCount }, (_, index) => {
      const id = `tab-${index}`
      const tab = terminalTab(id, 'worktree', null)
      Object.defineProperty(tab, 'id', {
        enumerable: true,
        get: () => {
          idReads += 1
          return id
        }
      })
      return tab
    })
    const layouts = Object.fromEntries(
      Array.from({ length: tabCount }, (_, index) => [`tab-${index}`, stableLayout()])
    )

    normalizeWorkspaceSessionPaneIdentities(workspaceSession({ worktree: tabs }, layouts))

    expect(idReads).toBe(tabCount)
  })
})
