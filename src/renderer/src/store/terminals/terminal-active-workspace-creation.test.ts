import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { AppState } from '../types'
import { createTestStore, makeWorktree, seedStore, TEST_REPO } from '../slices/store-test-helpers'

const createWebRuntimeSessionTerminalMock = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: createWebRuntimeSessionTerminalMock
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

vi.mock('@/lib/web-client-location', () => ({
  isWebClientLocation: () =>
    Boolean((globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__)
}))

const pairedWebFlag = globalThis as { __ORCA_WEB_CLIENT__?: boolean }

// Why: the SSH execution boundary forbids reporting loss of contact as process death.
const DEATH_CLAIM_RE = /\b(exited|dead|died|killed|stopped|terminated|crashed|offline)\b/i

function seedActiveWorkspace(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    activeWorktreeId: 'wt-1',
    settings: {
      activeRuntimeEnvironmentId: 'runtime-1'
    } as AppState['settings'],
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({
          id: 'wt-1',
          repoId: TEST_REPO.id,
          hostId: 'runtime:runtime-1',
          runtimeOwnerEnvironmentId: 'runtime-1'
        })
      ]
    },
    groupsByWorktree: {
      'wt-1': [{ id: 'group-1', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] }]
    },
    activeGroupIdByWorktree: { 'wt-1': 'group-1' }
  })
}

describe('openNewTerminalTabInActiveWorkspace routing outcome', () => {
  beforeEach(() => {
    createWebRuntimeSessionTerminalMock.mockReset()
  })

  afterEach(() => {
    delete pairedWebFlag.__ORCA_WEB_CLIENT__
  })

  it('reports the owning runtime failure instead of silently doing nothing', async () => {
    createWebRuntimeSessionTerminalMock.mockResolvedValue({
      status: 'failed',
      message: 'The workspace is not connected to a remote Orca host.'
    })
    const store = createTestStore()
    seedActiveWorkspace(store)

    const outcome = await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(outcome).toEqual({
      status: 'failed',
      message: 'The workspace is not connected to a remote Orca host.'
    })
    expect(store.getState().tabsByWorktree['wt-1'] ?? []).toEqual([])
  })

  it('reports unresolved ownership as unroutable without claiming the host is gone', async () => {
    const store = createTestStore()
    seedActiveWorkspace(store)
    store.setState({
      repos: [
        { ...TEST_REPO, executionHostId: 'runtime:hub-a' },
        { ...TEST_REPO, executionHostId: 'runtime:hub-b' }
      ],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id })]
      },
      settings: { activeRuntimeEnvironmentId: 'hub-b' } as AppState['settings']
    })

    const outcome = await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(outcome.status).toBe('unroutable')
    expect(outcome.status === 'unroutable' ? outcome.message : '').not.toMatch(DEATH_CLAIM_RE)
    expect(createWebRuntimeSessionTerminalMock).not.toHaveBeenCalled()
  })

  it('reports unroutable when a web client has no paired runtime for the workspace', async () => {
    pairedWebFlag.__ORCA_WEB_CLIENT__ = true
    const store = createTestStore()
    seedActiveWorkspace(store)
    store.setState({
      repos: [{ ...TEST_REPO, executionHostId: 'local' }],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, hostId: 'local' })]
      },
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings']
    })

    const outcome = await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(outcome.status).toBe('unroutable')
    expect(outcome.status === 'unroutable' ? outcome.message : '').not.toMatch(DEATH_CLAIM_RE)
    expect(store.getState().tabsByWorktree['wt-1'] ?? []).toEqual([])
  })

  it('reports unresolved folder ownership as unknown, not as an unpaired workspace', async () => {
    pairedWebFlag.__ORCA_WEB_CLIENT__ = true
    const workspaceKey = folderWorkspaceKey('folder-1')
    const store = createTestStore()
    // Why: the folder catalog has not hydrated, so no row says who owns this workspace.
    seedStore(store, {
      activeWorktreeId: workspaceKey,
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
      folderWorkspaces: [],
      projectGroups: [],
      groupsByWorktree: {
        [workspaceKey]: [
          {
            id: 'group-1',
            worktreeId: workspaceKey,
            activeTabId: null,
            tabOrder: []
          }
        ]
      },
      activeGroupIdByWorktree: { [workspaceKey]: 'group-1' }
    })

    const outcome = await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(outcome.status).toBe('unroutable')
    const message = outcome.status === 'unroutable' ? outcome.message : ''
    expect(message).not.toMatch(DEATH_CLAIM_RE)
    expect(message).not.toMatch(/not routed to a paired runtime/i)
    expect(message).toMatch(/cannot tell which execution host owns this workspace/i)
    expect(store.getState().tabsByWorktree[workspaceKey] ?? []).toEqual([])
  })

  it('keeps the unpaired-runtime copy when the folder catalog names a local owner', async () => {
    pairedWebFlag.__ORCA_WEB_CLIENT__ = true
    const workspaceKey = folderWorkspaceKey('folder-1')
    const store = createTestStore()
    seedStore(store, {
      activeWorktreeId: workspaceKey,
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'pg-1',
          name: 'Folder workspace',
          folderPath: '/tmp/folder',
          connectionId: null,
          executionHostId: 'local',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 1,
          lastActivityAt: 0,
          createdAt: 1,
          updatedAt: 1
        }
      ] as AppState['folderWorkspaces'],
      groupsByWorktree: {
        [workspaceKey]: [
          {
            id: 'group-1',
            worktreeId: workspaceKey,
            activeTabId: null,
            tabOrder: []
          }
        ]
      },
      activeGroupIdByWorktree: { [workspaceKey]: 'group-1' }
    })

    const outcome = await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(outcome.status).toBe('unroutable')
    expect(outcome.status === 'unroutable' ? outcome.message : '').toMatch(
      /not routed to a paired runtime/i
    )
  })

  it('reports a folder row that names no host as unknown, not as an unpaired workspace', async () => {
    pairedWebFlag.__ORCA_WEB_CLIENT__ = true
    const workspaceKey = folderWorkspaceKey('folder-1')
    const store = createTestStore()
    // Why: a HUB that predates the host/connection fields projects rows that name no owner at all.
    seedStore(store, {
      activeWorktreeId: workspaceKey,
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'pg-1',
          name: 'Folder workspace',
          folderPath: '/tmp/folder',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 1,
          lastActivityAt: 0,
          createdAt: 1,
          updatedAt: 1
        }
      ] as AppState['folderWorkspaces'],
      projectGroups: [
        {
          id: 'pg-1',
          name: 'Folder group',
          parentPath: '/tmp',
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ] as AppState['projectGroups'],
      groupsByWorktree: {
        [workspaceKey]: [
          {
            id: 'group-1',
            worktreeId: workspaceKey,
            activeTabId: null,
            tabOrder: []
          }
        ]
      },
      activeGroupIdByWorktree: { [workspaceKey]: 'group-1' }
    })

    const outcome = await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(outcome.status).toBe('unroutable')
    const message = outcome.status === 'unroutable' ? outcome.message : ''
    expect(message).not.toMatch(DEATH_CLAIM_RE)
    expect(message).not.toMatch(/not routed to a paired runtime/i)
    expect(message).toMatch(/cannot tell which execution host owns this workspace/i)
    expect(store.getState().tabsByWorktree[workspaceKey] ?? []).toEqual([])
  })

  it('keeps the unknown verdict when the sidebar launders the pseudo-worktree local default', async () => {
    pairedWebFlag.__ORCA_WEB_CLIENT__ = true
    const workspaceKey = folderWorkspaceKey('folder-1')
    const store = createTestStore()
    // Why: folderWorkspaceToWorktree defaults hostId to 'local', and the sidebar click records that
    // default as the active host — the same missing evidence must not read as a named local owner.
    seedStore(store, {
      activeWorktreeId: workspaceKey,
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'pg-1',
          name: 'Folder workspace',
          folderPath: '/tmp/folder',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 1,
          lastActivityAt: 0,
          createdAt: 1,
          updatedAt: 1
        }
      ] as AppState['folderWorkspaces'],
      projectGroups: [
        {
          id: 'pg-1',
          name: 'Folder group',
          parentPath: '/tmp',
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ] as AppState['projectGroups'],
      groupsByWorktree: {
        [workspaceKey]: [
          {
            id: 'group-1',
            worktreeId: workspaceKey,
            activeTabId: null,
            tabOrder: []
          }
        ]
      },
      activeGroupIdByWorktree: { [workspaceKey]: 'group-1' }
    })
    store.setState({ activeWorkspaceExecutionHostId: 'local' })

    const outcome = await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(outcome.status).toBe('unroutable')
    const message = outcome.status === 'unroutable' ? outcome.message : ''
    expect(message).not.toMatch(DEATH_CLAIM_RE)
    expect(message).not.toMatch(/not routed to a paired runtime/i)
    expect(message).toMatch(/cannot tell which execution host owns this workspace/i)
  })

  it('reports an ssh-hosted folder owner as unknown, not as an unpaired workspace', async () => {
    pairedWebFlag.__ORCA_WEB_CLIENT__ = true
    const workspaceKey = folderWorkspaceKey('folder-1')
    const store = createTestStore()
    // Why: an ssh host names the target, not the HUB proxying it, so no row says a runtime is unpaired.
    seedStore(store, {
      activeWorktreeId: workspaceKey,
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'pg-1',
          name: 'Folder workspace',
          folderPath: '/tmp/folder',
          connectionId: 'conn-1',
          executionHostId: 'ssh:conn-1',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 1,
          lastActivityAt: 0,
          createdAt: 1,
          updatedAt: 1
        }
      ] as AppState['folderWorkspaces'],
      groupsByWorktree: {
        [workspaceKey]: [
          {
            id: 'group-1',
            worktreeId: workspaceKey,
            activeTabId: null,
            tabOrder: []
          }
        ]
      },
      activeGroupIdByWorktree: { [workspaceKey]: 'group-1' }
    })

    const outcome = await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(outcome.status).toBe('unroutable')
    const message = outcome.status === 'unroutable' ? outcome.message : ''
    expect(message).not.toMatch(DEATH_CLAIM_RE)
    expect(message).not.toMatch(/not routed to a paired runtime/i)
    expect(message).toMatch(/cannot tell which execution host owns this workspace/i)
    expect(createWebRuntimeSessionTerminalMock).not.toHaveBeenCalled()
  })

  it('reports rival HUB owners as ambiguous, not as an unpaired workspace', async () => {
    pairedWebFlag.__ORCA_WEB_CLIENT__ = true
    const store = createTestStore()
    seedActiveWorkspace(store)
    store.setState({
      activeWorkspaceExecutionHostId: 'ssh:conn-1',
      repos: [],
      worktreesByRepo: {
        'repo-a': [
          makeWorktree({
            id: 'wt-1',
            repoId: 'repo-a',
            hostId: 'ssh:conn-1',
            runtimeOwnerEnvironmentId: 'hub-a'
          })
        ],
        'repo-b': [
          makeWorktree({
            id: 'wt-1',
            repoId: 'repo-b',
            hostId: 'ssh:conn-1',
            runtimeOwnerEnvironmentId: 'hub-b'
          })
        ]
      },
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings']
    })

    const outcome = await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(outcome.status).toBe('unroutable')
    const message = outcome.status === 'unroutable' ? outcome.message : ''
    expect(message).not.toMatch(DEATH_CLAIM_RE)
    expect(message).not.toMatch(/not routed to a paired runtime/i)
    expect(message).toMatch(/More than one execution host claims this workspace/i)
  })

  it('reports an unhydrated worktree owner as unknown, not as an unpaired workspace', async () => {
    pairedWebFlag.__ORCA_WEB_CLIENT__ = true
    const store = createTestStore()
    seedActiveWorkspace(store)
    // Why: no owner row has landed yet, so nothing says whether a runtime is paired.
    store.setState({
      activeWorkspaceExecutionHostId: 'ssh:conn-1',
      repos: [],
      worktreesByRepo: {},
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings']
    })

    const outcome = await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(outcome.status).toBe('unroutable')
    const message = outcome.status === 'unroutable' ? outcome.message : ''
    expect(message).not.toMatch(DEATH_CLAIM_RE)
    expect(message).not.toMatch(/not routed to a paired runtime/i)
    expect(message).toMatch(/cannot tell which execution host owns this workspace/i)
  })

  it('reports created for a local desktop terminal', async () => {
    const store = createTestStore()
    seedStore(store, {
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
      groupsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: 'group-1',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            activeTabId: null,
            tabOrder: []
          }
        ]
      },
      activeGroupIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'group-1' }
    })

    const outcome = await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(outcome).toEqual({ status: 'created' })
    expect(store.getState().tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).toHaveLength(1)
  })

  it('stays silent when no workspace is active', async () => {
    const store = createTestStore()
    seedStore(store, { activeWorktreeId: null })

    const outcome = await store.getState().openNewTerminalTabInActiveWorkspace('group-1')

    expect(outcome).toEqual({ status: 'no-active-workspace' })
  })
})
