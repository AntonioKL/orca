// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activeTab: {
    id: 'structured-agent-session-claude-1',
    entityId: 'claude-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'agent-session' as const,
    agentSessionAgent: 'claude' as unknown,
    label: 'Claude Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      rightSidebarOpen: false,
      sidebarOpen: false,
      groupsByWorktree: { 'wt-1': [{ id: 'group-1' }] }
    })
}))

vi.mock('./useTabGroupWorkspaceModel', () => ({
  useTabGroupWorkspaceModel: () => ({
    activeTab: mocks.activeTab,
    agentSessionItems: [],
    browserItems: [],
    commands: new Proxy({}, { get: () => vi.fn() }),
    editorItems: [],
    expandedPaneByTabId: {},
    groupTabs: [mocks.activeTab],
    tabBarOrder: [],
    terminalTabs: []
  })
}))

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: vi.fn() })
}))

vi.mock('../tab-bar/TabBar', () => ({ default: () => null }))
vi.mock('../tab-bar/TabBarQuickCommandsButton', () => ({
  TabBarQuickCommandsButton: () => null
}))
vi.mock('@/lib/lazy-with-retry', () => ({ lazyWithRetry: () => () => null }))
vi.mock('@/lib/pane-manager/client-hosted-browser-row-state', () => ({
  useClientHostedBrowserRows: () => []
}))
vi.mock('../tab-bar/client-hosted-browser-row-strip-placement', () => ({
  resolveClientHostedBrowserRowStripGroupId: () => 'group-1'
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local',
  getRuntimeEnvironmentIdForWorktree: () => null
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))
vi.mock('../native-chat/NativeChatView', () => ({
  default: ({ agent, sessionId }: { agent: string; sessionId: string }) => (
    <div data-testid="structured-chat" data-agent={agent} data-session-id={sessionId} />
  )
}))

import TabGroupPanel from './TabGroupPanel'

afterEach(cleanup)

function renderPanel(): ReturnType<typeof render> {
  return render(
    <TabGroupPanel
      groupId="group-1"
      worktreeId="wt-1"
      isVisible
      isFocused
      hasSplitGroups={false}
      touchesRightEdge
      touchesLeftEdge
      reserveClosedExplorerToggleSpace={false}
      reserveCollapsedSidebarHeaderSpace={false}
    />
  )
}

describe('TabGroupPanel structured provider rendering', () => {
  it('passes Claude to the structured native chat surface', () => {
    mocks.activeTab.agentSessionAgent = 'claude'
    const view = renderPanel().getByTestId('structured-chat')

    expect(view.getAttribute('data-agent')).toBe('claude')
    expect(view.getAttribute('data-session-id')).toBe('claude-1')
  })

  it('renders no structured surface for an unknown provider', () => {
    mocks.activeTab.agentSessionAgent = 'gemini'
    expect(renderPanel().queryByTestId('structured-chat')).toBeNull()
  })
})
