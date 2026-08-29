import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { View, Text, SectionList, Pressable, Alert, RefreshControl } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect } from 'expo-router'
import {
  Search,
  X,
  Pin,
  List,
  SlidersHorizontal,
  Layers,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Plus,
  Moon,
  Filter,
  Check,
  UserCircle,
  PanelLeftClose,
  SquareTerminal
} from 'lucide-react-native'
import { useHostClient } from '../../../src/transport/client-context'
import { useMobileWebRouteParams } from '../../../src/mobile-web/use-mobile-web-route-params'
import { useWorktreeResync } from '../../../src/transport/use-worktree-resync'
import { startHostWorktreeRefresh } from '../../../src/worktree/host-worktree-refresh'
import {
  applyWorktreeRowDisplayState,
  clearConfirmedActiveWorktreeIdentity,
  getWorktreeRowIdentity,
  removeWorktreeRow,
  retainLiveSleptWorktreeIdentities
} from '../../../src/worktree/worktree-host-row-identity'
import {
  useLastConnectedAt,
  useRelayRecoveryStatus,
  useReconnectAttempt
} from '../../../src/transport/client-context-connection-metrics'
import {
  classifyConnection,
  type ConnectionVerdict
} from '../../../src/transport/connection-health'
import { StatusDot } from '../../../src/components/StatusDot'
import { NewWorktreeModalController } from '../../../src/components/NewWorktreeModalController'
import { NewWorkspaceFab, FAB_SIZE } from '../../../src/components/NewWorkspaceFab'
import { MobileRepoIcon } from '../../../src/components/MobileRepoIcon'
import { WorktreeListRow } from '../../../src/components/WorktreeListRow'
import { useNow } from '../../../src/hooks/use-now'
import { useActiveWorktreeScroll } from '../../../src/hooks/use-active-worktree-scroll'
import type { RepoIcon } from '../../../../src/shared/repo-icon'
import { PickerModal } from '../../../src/components/PickerModal'
import { ActionSheetContent } from '../../../src/components/ActionSheetModal'
import { buildWorktreeNavigationActions } from '../../../src/agent-history/worktree-navigation-actions'
import { floatingWorkspaceSessionPath } from '../../../src/session/floating-workspace'
import { ConfirmModal } from '../../../src/components/ConfirmModal'
import { BottomDrawer } from '../../../src/components/BottomDrawer'
import { useHostProtocolGates } from '../../../src/components/host-protocol-gates-context'
import { AuthFailedBanner } from '../../../src/components/AuthFailedBanner'
import { HostDiagnosticsLink } from '../../../src/components/HostDiagnosticsLink'
import { HostRouteNoticeBanner } from '../../../src/components/HostRouteNoticeBanner'
import { visibleHostRouteNotice } from '../../../src/host-route-notice'
import { MobileSearchField } from '../../../src/components/MobileSearchField'
import { WorkspaceDetailPlaceholder } from '../../../src/components/WorkspaceDetailPlaceholder'
import { colors, spacing } from '../../../src/theme/mobile-theme'
import { useResponsiveLayout } from '../../../src/layout/responsive-layout'
import { hostScreenStyles as styles } from '../../../src/host-screen/host-screen-styles'
import {
  createInitialHostRouteActionState,
  hostNewWorktreeSessionRoute,
  resolveHostRouteActionState,
  setHostRouteNewWorktreeVisible
} from '../../../src/host-route-action-state'
import {
  applyDesktopViewSettings,
  buildWorkspaceViewSettingsUpdate,
  type MobileGroupMode,
  type MobileSortMode,
  type MobileViewState,
  type WorkspaceViewSettings
} from '../../../src/worktree/workspace-view-settings'
import {
  getWorktreeStatus,
  isWorktreePinned,
  type FilterState,
  type Worktree
} from '../../../src/worktree/workspace-list-sections'
import { useWorkspaceSections } from '../../../src/worktree/use-workspace-sections'
import { getMobileWorkspaceLineageGroupKey } from '../../../src/worktree/mobile-workspace-lineage'
import { areWorktreeListsEqual } from '../../../src/worktree/worktree-list-snapshot'
import { HostWorkspaceListStates } from '../../../src/worktree/host-workspace-list-states'
import { repoColor } from '../../../src/worktree/repo-color'
import {
  WORKSPACE_GROUP_OPTIONS as GROUP_OPTIONS,
  WORKSPACE_SORT_OPTIONS as SORT_OPTIONS
} from '../../../src/worktree/workspace-list-picker-options'
import type { HostWorkspaceOperations } from '../../../src/worktree/host-workspace-operations'
import type { HostScreenHostState } from '../../../src/worktree/host-screen-host-state'
import { defaultHostScreenHostState } from '../../../src/worktree/default-host-screen-host-state'
import { defaultHostWorkspaceOperations } from '../../../src/worktree/default-host-workspace-operations'
import { defaultHostWorkspaceCreationOperations } from '../../../src/worktree/default-host-workspace-creation-operations'
import { useDefaultHostScreenShellOperations } from '../../../src/worktree/default-host-screen-shell-operations'
import type { HostScreenShellOperations } from '../../../src/worktree/host-screen-shell-operations'
import type { HostWorkspaceCreationOperations } from '../../../src/worktree/host-workspace-creation-operations'
import type { WorkspaceStatusDefinition } from '../../../../src/shared/worktree/types'
import { DEFAULT_MOBILE_WORKSPACE_STATUSES } from '../../../src/worktree/mobile-workspace-statuses'
import type { ConnectionState } from '../../../src/transport/types'

function isErrorVerdict(v: ConnectionVerdict): boolean {
  return v.kind === 'warning' || v.kind === 'unreachable' || v.kind === 'auth-failed'
}

const REPO_METADATA_REFRESH_MS = 60_000

type HostScreenProps = {
  // When true, rendered as the persistent tablet sidebar by the host layout, not as its own routed screen.
  embedded?: boolean
  // Route params aren't in scope when rendered from the layout, so the caller passes these explicitly.
  hostId?: string
  action?: string
  onHideSidebar?: () => void
  workspaceOperations?: HostWorkspaceOperations
  workspaceCreationOperations?: HostWorkspaceCreationOperations
  connectionState?: ConnectionState
  connectionMetrics?: {
    reconnectAttempts: number
    lastConnectedAt: number | null
  }
  nativeHostBinding?: boolean
  hostState?: HostScreenHostState
  shellOperations?: HostScreenShellOperations
}

export function HostScreen({
  embedded = false,
  hostId: hostIdProp,
  action: actionProp,
  onHideSidebar,
  workspaceOperations: workspaceOperationsProp,
  workspaceCreationOperations: workspaceCreationOperationsProp,
  connectionState: connectionStateProp,
  connectionMetrics,
  nativeHostBinding = true,
  hostState: hostStateProp,
  shellOperations: shellOperationsProp
}: HostScreenProps = {}) {
  const params = useMobileWebRouteParams<{ hostId: string; action?: string; notice?: string }>()
  const hostId = hostIdProp ?? params.hostId
  const action = actionProp ?? params.action
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null)
  const noticeParam = params.notice?.trim()
  const routeNotice = visibleHostRouteNotice(embedded, noticeParam, dismissedNotice)
  const insets = useSafeAreaInsets()
  const hostState = hostStateProp ?? defaultHostScreenHostState
  // Why: cap and center the list on wide/tablet canvases; on phones isWideLayout is false so it stays edge-to-edge.
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  const [initialCache] = useState(() => (hostId ? hostState.cachedWorkspaces(hostId) : null))
  // Shared client per host owned by RpcClientProvider. See docs/mobile-shared-client-per-host.md.
  const nativeHost = useHostClient(nativeHostBinding ? hostId : undefined)
  const client = nativeHost.client
  const connState = connectionStateProp ?? nativeHost.state
  const workspaceOperations = useMemo(
    () => workspaceOperationsProp ?? (client ? defaultHostWorkspaceOperations(client) : null),
    [client, workspaceOperationsProp]
  )
  const workspaceCreationOperations = useMemo(
    () =>
      workspaceCreationOperationsProp ??
      (client ? defaultHostWorkspaceCreationOperations(client) : null),
    [client, workspaceCreationOperationsProp]
  )
  const nativeReconnectAttempts = useReconnectAttempt(hostId)
  const nativeLastConnectedAt = useLastConnectedAt(hostId)
  const reconnectAttempts = connectionMetrics?.reconnectAttempts ?? nativeReconnectAttempts
  const lastConnectedAt = connectionMetrics?.lastConnectedAt ?? nativeLastConnectedAt
  const defaultShellOperations = useDefaultHostScreenShellOperations({ hostId, embedded })
  const shellOperations = shellOperationsProp ?? defaultShellOperations
  const workspaceOperationsRef = useRef<HostWorkspaceOperations | null>(null)
  const relayRecovery = useRelayRecoveryStatus(nativeHostBinding ? hostId : undefined)
  const fetchWorktreesInFlightRef = useRef(false)
  const fetchRepoMetadataInFlightRef = useRef(new WeakSet<HostWorkspaceOperations>())
  const fetchRepoMetadataPendingRef = useRef(new WeakSet<HostWorkspaceOperations>())
  const repoMetadataFetchedAtRef = useRef(0)
  const newWorktreeModalRef = useRef<{ open: () => void }>(null)
  const newWorktreeModalVisibleRef = useRef(false)
  const [worktrees, setWorktrees] = useState<Worktree[]>(initialCache ?? [])
  const [worktreesLoaded, setWorktreesLoaded] = useState(initialCache != null)
  // Why (STA-3123): error code of the last failed worktree.ps, so a broken catalog
  // path renders as a failure instead of an empty host. Cleared on the next success.
  const [catalogError, setCatalogError] = useState<string | null>(null)
  // Why: track the locally-opened worktree so the active-row highlight moves instantly instead of waiting for the next poll.
  const [optimisticActiveWorktreeIdentity, setOptimisticActiveWorktreeIdentity] = useState<
    string | null
  >(null)
  // One tick drives every visible agent row's relative timestamp.
  const now = useNow(30_000)
  const [repoColorsByName, setRepoColorsByName] = useState<Map<string, string>>(new Map())
  const [repoIconsByName, setRepoIconsByName] = useState<Map<string, RepoIcon>>(new Map())
  const [hostName, setHostName] = useState('')
  const [hostPublicKey, setHostPublicKey] = useState('')
  const [error, setError] = useState('')
  const [lastKnownWorktrees, setLastKnownWorktrees] = useState<Worktree[]>(initialCache ?? [])
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [sortMode, setSortMode] = useState<MobileSortMode>('recent')
  const [filters, setFilters] = useState<FilterState>({
    filterRepoIds: new Set(),
    hideSleeping: false,
    hideDefaultBranch: false,
    alwaysShowDefaultBranch: true
  })
  const [groupMode, setGroupMode] = useState<MobileGroupMode>('repo')
  const [workspaceStatuses, setWorkspaceStatuses] = useState<readonly WorkspaceStatusDefinition[]>(
    DEFAULT_MOBILE_WORKSPACE_STATUSES
  )
  // displayName → repo id: filters key on repo id, but section headers/rows key on displayName, so bridge the two.
  const [repoIdsByName, setRepoIdsByName] = useState<Map<string, string>>(new Map())
  const [showSortPicker, setShowSortPicker] = useState(false)
  const [showGroupPicker, setShowGroupPicker] = useState(false)
  const [showFilterModal, setShowFilterModal] = useState(false)
  const [actionTarget, setActionTarget] = useState<Worktree | null>(null)
  const { hostCapabilities, floatingWorkspaceEnabled } = useHostProtocolGates()
  const [confirmDelete, setConfirmDelete] = useState<Worktree | null>(null)
  const [confirmRemoveHost, setConfirmRemoveHost] = useState(false)
  const [routeActionState, setRouteActionState] = useState(() =>
    createInitialHostRouteActionState(action)
  )
  const [sleptIds, setSleptIds] = useState<Set<string>>(new Set())

  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  // Why: ref so the ui.get merge and ui.set writes read the latest values without re-creating callbacks on every state change.
  const viewStateRef = useRef<MobileViewState>({
    groupMode: 'repo',
    sortMode: 'recent',
    hideSleeping: false,
    hideDefaultBranch: false,
    alwaysShowDefaultBranch: true,
    filterRepoIds: [],
    collapsedGroups: [],
    workspaceStatuses: DEFAULT_MOBILE_WORKSPACE_STATUSES
  })

  useEffect(() => {
    viewStateRef.current = {
      groupMode,
      sortMode,
      hideSleeping: filters.hideSleeping,
      hideDefaultBranch: filters.hideDefaultBranch,
      alwaysShowDefaultBranch: filters.alwaysShowDefaultBranch !== false,
      filterRepoIds: [...filters.filterRepoIds],
      collapsedGroups: [...collapsedGroups],
      workspaceStatuses
    }
  }, [groupMode, sortMode, filters, collapsedGroups, workspaceStatuses])

  // Apply a MobileViewState onto the individual states and the snapshot ref in one shot.
  const applyViewState = useCallback((next: MobileViewState) => {
    viewStateRef.current = next
    setGroupMode(next.groupMode)
    setSortMode(next.sortMode)
    setWorkspaceStatuses(next.workspaceStatuses)
    setCollapsedGroups(new Set(next.collapsedGroups))
    setFilters({
      filterRepoIds: new Set(next.filterRepoIds),
      hideSleeping: next.hideSleeping,
      hideDefaultBranch: next.hideDefaultBranch,
      alwaysShowDefaultBranch: next.alwaysShowDefaultBranch
    })
  }, [])

  // Apply the change locally, then patch the desktop's shared store (ui.set) so both apps stay in sync.
  const persistViewSettings = useCallback(
    (patch: Partial<MobileViewState>) => {
      const next: MobileViewState = { ...viewStateRef.current, ...patch }
      applyViewState(next)
      if (!workspaceOperations) {
        return
      }
      // Send only the touched fields: the host merges partial updates, so a stale
      // mirror can no longer revert sibling settings another client just changed
      // (STA-5781; supersedes the #8873 whole-payload special case).
      const payload: WorkspaceViewSettings = buildWorkspaceViewSettingsUpdate(patch, next)
      if (Object.keys(payload).length === 0) {
        return
      }
      void workspaceOperations.setViewSettings(payload).catch(() => {
        // Best-effort: view settings are a convenience preference.
      })
    },
    [workspaceOperations, applyViewState]
  )

  const openNewWorktreeModal = useCallback(() => {
    const modal = newWorktreeModalRef.current
    if (!modal) {
      return
    }
    newWorktreeModalVisibleRef.current = true
    modal.open()
  }, [])

  const resolvedRouteActionState = resolveHostRouteActionState(routeActionState, action)
  // Why: resolve `action=newWorktree` before commit, but don't reopen after the user closes while the URL persists.
  if (resolvedRouteActionState !== routeActionState) {
    setRouteActionState(resolvedRouteActionState)
  }
  const showNewWorktree = resolvedRouteActionState.showNewWorktree
  const setShowNewWorktreeVisible = useCallback((visible: boolean) => {
    setRouteActionState((current) => setHostRouteNewWorktreeVisible(current, visible))
  }, [])

  // Load persisted pins from local cache; view settings are no longer local (they sync via ui.get).
  useEffect(() => {
    if (!hostId) {
      return
    }
    let stale = false
    void (async () => {
      const pins = await hostState.loadPinnedWorkspaceIds(hostId)
      if (stale) {
        return
      }
      setPinnedIds(pins)
    })()
    return () => {
      stale = true
    }
  }, [hostId, hostState])

  // Merge the desktop's shared view settings (PersistedUIState) onto local state so desktop changes appear here.
  const syncViewSettingsFromDesktop = useCallback(async () => {
    if (!workspaceOperations || connState !== 'connected') {
      return
    }
    const requestOperations = workspaceOperations
    const requestHostId = hostId
    try {
      const ui = await requestOperations.getViewSettings()
      if (workspaceOperationsRef.current !== requestOperations || hostId !== requestHostId || !ui) {
        return
      }
      applyViewState(applyDesktopViewSettings(viewStateRef.current, ui))
    } catch {
      // Transient transport failure; retry on the next focus/connect.
    }
  }, [workspaceOperations, connState, hostId, applyViewState])

  // Why: imperative refreshes must reject responses from an adapter replaced during reconnect.
  useEffect(() => {
    workspaceOperationsRef.current = workspaceOperations
  }, [workspaceOperations])

  useEffect(() => {
    setHostName('')
    setHostPublicKey('')
    setError('')
    setRepoColorsByName(new Map())
    setRepoIconsByName(new Map())
    repoMetadataFetchedAtRef.current = 0
    // Why: useState initializer runs only on first mount, so re-seed the cache when Expo Router reuses this screen for a new hostId.
    const freshCache = hostId ? hostState.cachedWorkspaces(hostId) : null
    if (freshCache) {
      setWorktrees(freshCache)
      setLastKnownWorktrees(freshCache)
      setWorktreesLoaded(true)
    } else {
      setWorktreesLoaded(false)
      setWorktrees([])
      setLastKnownWorktrees([])
    }
    if (!hostId) {
      return
    }
    let stale = false
    void hostState.loadIdentity(hostId).then((host) => {
      if (stale) {
        return
      }
      if (!host) {
        setError('Host not found')
        return
      }
      setHostName(host.name)
      setHostPublicKey(host.publicKeyB64)
      void hostState.recordConnected(hostId)
    })
    return () => {
      stale = true
    }
  }, [hostId, hostState])

  const fetchRepoMetadata = useCallback(
    async (options: { force?: boolean; queueIfInFlight?: boolean } = {}) => {
      if (!workspaceOperations || connState !== 'connected' || !hostId) {
        return
      }
      if (fetchRepoMetadataInFlightRef.current.has(workspaceOperations)) {
        if (options.queueIfInFlight) {
          fetchRepoMetadataPendingRef.current.add(workspaceOperations)
        }
        return
      }
      const now = Date.now()
      if (!options.force && now - repoMetadataFetchedAtRef.current < REPO_METADATA_REFRESH_MS) {
        return
      }
      fetchRepoMetadataInFlightRef.current.add(workspaceOperations)
      const requestOperations = workspaceOperations,
        requestHostId = hostId
      try {
        do {
          fetchRepoMetadataPendingRef.current.delete(requestOperations)
          const repos = await requestOperations.listRepos()
          if (workspaceOperationsRef.current !== requestOperations || hostId !== requestHostId) {
            return
          }
          repoMetadataFetchedAtRef.current = Date.now()
          hostState.cacheRepositories(requestHostId, repos)
          setRepoColorsByName(
            new Map(
              repos.map((repo) => [
                repo.displayName,
                repo.badgeColor || repoColor(repo.displayName)
              ])
            )
          )
          setRepoIconsByName(
            new Map(
              repos.flatMap((repo) =>
                repo.repoIcon ? [[repo.displayName, repo.repoIcon] as const] : []
              )
            )
          )
          setRepoIdsByName(new Map(repos.map((repo) => [repo.displayName, repo.id])))
        } while (fetchRepoMetadataPendingRef.current.has(requestOperations))
      } catch {
        // Repo metadata is decorative; the next refresh can retry.
      } finally {
        fetchRepoMetadataInFlightRef.current.delete(requestOperations)
      }
    },
    [workspaceOperations, connState, hostId, hostState]
  )

  const fetchWorktrees = useCallback(
    async (options: { allowDuringModal?: boolean } = {}) => {
      if (!workspaceOperations || connState !== 'connected') {
        return
      }
      if (!options.allowDuringModal && newWorktreeModalVisibleRef.current) {
        return
      }
      // Why: prevent slow remote hosts from stacking overlapping worktree.ps requests during polling.
      if (fetchWorktreesInFlightRef.current) {
        return
      }
      fetchWorktreesInFlightRef.current = true
      const requestOperations = workspaceOperations
      const requestHostId = hostId

      try {
        // Why: request the complete host list; each transport adapter owns its safe batching.
        const nextWorktrees = await requestOperations.listWorkspaces(10000)
        if (workspaceOperationsRef.current !== requestOperations || hostId !== requestHostId) {
          return
        }
        if (!options.allowDuringModal && newWorktreeModalVisibleRef.current) {
          return
        }
        // Why: reuse the existing array on identical snapshots to keep SectionList/sort rebuilds off the tap path.
        setWorktrees((current) =>
          areWorktreeListsEqual(current, nextWorktrees) ? current : nextWorktrees
        )
        setLastKnownWorktrees((current) =>
          areWorktreeListsEqual(current, nextWorktrees) ? current : nextWorktrees
        )
        setWorktreesLoaded(true)
        // Why (#8498): overwrite the home-written cache with the confirmed snapshot so a reconnect/remount can't serve a stale list.
        if (hostId) {
          hostState.cacheWorkspaces(hostId, nextWorktrees)
        }
        // Drop the optimistic active override once the host reports it active, so later desktop changes win.
        setOptimisticActiveWorktreeIdentity((pending) =>
          clearConfirmedActiveWorktreeIdentity(pending, nextWorktrees)
        )

        // Clear optimistic sleep overrides once the server confirms inactive (liveTerminalCount === 0).
        setSleptIds((prev) => retainLiveSleptWorktreeIdentities(prev, nextWorktrees))

        // Sync pin state from server so desktop-initiated pins reflect without relying on stale AsyncStorage.
        const serverPinned = new Set(
          nextWorktrees.filter((w) => w.isPinned).map((w) => w.worktreeId)
        )
        setPinnedIds((prev) => {
          if (serverPinned.size === prev.size && [...serverPinned].every((id) => prev.has(id))) {
            return prev
          }
          if (hostId) {
            void hostState.savePinnedWorkspaceIds(hostId, serverPinned)
          }
          return serverPinned
        })
      } catch {
        // Will retry on reconnect
        if (workspaceOperationsRef.current === requestOperations && hostId === requestHostId) {
          setCatalogError('network_error')
        }
      } finally {
        fetchWorktreesInFlightRef.current = false
      }
    },
    [workspaceOperations, connState, hostId, hostState]
  )

  useFocusEffect(
    useCallback(() => {
      // Why: focus nudges reconnect and probes a possibly half-open socket; empty deps fire per focus, not per state flip (which defeats backoff).
      workspaceOperationsRef.current?.notifyForeground()
    }, [])
  )

  const startWorktreeRefresh = useCallback(() => {
    if (!workspaceOperations || connState !== 'connected') {
      return
    }
    void syncViewSettingsFromDesktop()
    return startHostWorktreeRefresh({
      operations: workspaceOperations,
      fetchWorktrees,
      fetchRepoMetadata
    })
  }, [
    workspaceOperations,
    connState,
    fetchWorktrees,
    fetchRepoMetadata,
    syncViewSettingsFromDesktop
  ])

  useFocusEffect(
    useCallback(() => {
      // The embedded sidebar isn't a routed screen (focus never fires); it refreshes via the mount effect below.
      if (!embedded) {
        return startWorktreeRefresh()
      }
    }, [embedded, startWorktreeRefresh])
  )

  // Why: the embedded sidebar is never the focused route, so wire its refresh lifecycle from a mount effect.
  useEffect(() => {
    if (embedded) {
      return startWorktreeRefresh()
    }
  }, [embedded, startWorktreeRefresh])

  // Why (#8498): steady-state polls miss the transition INTO 'connected' after background/sleep, when the cache is stalest.
  const { refreshing, onRefresh } = useWorktreeResync({
    available: workspaceOperations !== null,
    connState,
    fetchWorktrees,
    fetchRepoMetadata
  })

  const updateLocalPins = useCallback(
    (worktreeId: string, pinned: boolean) => {
      setPinnedIds((prev) => {
        const next = new Set(prev)
        if (pinned) {
          next.add(worktreeId)
        } else {
          next.delete(worktreeId)
        }
        if (hostId) {
          void hostState.savePinnedWorkspaceIds(hostId, next)
        }
        return next
      })
    },
    [hostId, hostState]
  )

  const togglePin = useCallback(
    (worktreeId: string) => {
      const worktree = worktrees.find((w) => w.worktreeId === worktreeId)
      const currentlyPinned = worktree
        ? isWorktreePinned(worktree, pinnedIds)
        : pinnedIds.has(worktreeId)
      const newPinned = !currentlyPinned

      setWorktrees((prev) =>
        prev.map((w) => (w.worktreeId === worktreeId ? { ...w, isPinned: newPinned } : w))
      )
      setLastKnownWorktrees((prev) =>
        prev.map((w) => (w.worktreeId === worktreeId ? { ...w, isPinned: newPinned } : w))
      )

      updateLocalPins(worktreeId, newPinned)

      if (workspaceOperations) {
        void workspaceOperations.setPinned(worktreeId, newPinned).catch(() => {})
      }
    },
    [workspaceOperations, worktrees, pinnedIds, updateLocalPins]
  )

  const handleDeleteWorktree = useCallback(
    async (item: Worktree) => {
      if (!workspaceOperations) {
        return
      }

      const removeFromList = (list: Worktree[]) => removeWorktreeRow(list, item)
      setWorktrees(removeFromList)
      setLastKnownWorktrees(removeFromList)

      try {
        const removed = await workspaceOperations.removeWorkspace(item.worktreeId)
        if (!removed) {
          setWorktrees((prev) => [...prev, item])
          setLastKnownWorktrees((prev) => [...prev, item])
        }
        void fetchWorktrees()
      } catch {
        setWorktrees((prev) => [...prev, item])
        setLastKnownWorktrees((prev) => [...prev, item])
      }
    },
    [workspaceOperations, fetchWorktrees]
  )

  const handleRemoveHost = useCallback(async () => {
    if (!hostId) {
      return
    }
    try {
      await shellOperations.removeHost(hostPublicKey)
      shellOperations.leaveHost()
    } catch {
      // Why: removal can fail while still paired; re-open confirm (ConfirmModal closes on confirm).
      setConfirmRemoveHost(true)
      Alert.alert('Could not remove host', 'Please try again.')
    }
  }, [hostId, hostPublicKey, shellOperations])

  const navigateFromHostList = shellOperations.navigateFromHostList

  const openWorktreeSession = useCallback(
    (item: Worktree) => {
      setOptimisticActiveWorktreeIdentity(getWorktreeRowIdentity(item))
      if (workspaceOperations && connState === 'connected') {
        void workspaceOperations.activateWorkspace(item.worktreeId).catch(() => null)
      }
      const target = `/h/${hostId}/session/${encodeURIComponent(item.worktreeId)}?name=${encodeURIComponent(item.displayName || item.repo)}`
      navigateFromHostList(target)
    },
    [workspaceOperations, connState, hostId, navigateFromHostList]
  )

  const openFloatingWorkspace = useCallback(() => {
    // Why: no worktree.activate here — the floating sentinel has no worktree
    // record; session.tabs.list hydrates its host-owned tabs on open.
    navigateFromHostList(floatingWorkspaceSessionPath(hostId))
  }, [hostId, navigateFromHostList])

  const handleSortChange = useCallback(
    (value: MobileSortMode) => {
      persistViewSettings({ sortMode: value })
    },
    [persistViewSettings]
  )

  const toggleHideSleeping = useCallback(() => {
    persistViewSettings({ hideSleeping: !viewStateRef.current.hideSleeping })
  }, [persistViewSettings])

  const toggleHideDefaultBranch = useCallback(() => {
    persistViewSettings({ hideDefaultBranch: !viewStateRef.current.hideDefaultBranch })
  }, [persistViewSettings])

  const toggleRepoFilter = useCallback(
    (repoId: string) => {
      const next = new Set(viewStateRef.current.filterRepoIds)
      if (next.has(repoId)) {
        next.delete(repoId)
      } else {
        next.add(repoId)
      }
      persistViewSettings({ filterRepoIds: [...next] })
    },
    [persistViewSettings]
  )

  const clearFilters = useCallback(() => {
    persistViewSettings({ hideSleeping: false, hideDefaultBranch: false, filterRepoIds: [] })
  }, [persistViewSettings])

  const activeFilterCount = useMemo(() => {
    let count = 0
    if (filters.hideSleeping) {
      count++
    }
    if (filters.hideDefaultBranch) {
      count++
    }
    count += filters.filterRepoIds.size
    return count
  }, [filters])
  const selectedSortLabel =
    SORT_OPTIONS.find((option) => option.value === sortMode)?.label ?? 'Recent'

  const handleGroupChange = useCallback(
    (value: MobileGroupMode) => {
      persistViewSettings({ groupMode: value })
    },
    [persistViewSettings]
  )

  const displayWorktrees = useMemo(() => {
    // Why: live `worktrees` is authoritative only while connected; under the amber
    // mount default, connecting/handshaking must keep the pre-reconnect list too.
    const base = connState === 'connected' ? worktrees : lastKnownWorktrees
    return applyWorktreeRowDisplayState(base, sleptIds, optimisticActiveWorktreeIdentity)
  }, [connState, worktrees, lastKnownWorktrees, sleptIds, optimisticActiveWorktreeIdentity])

  const toggleCollapsed = useCallback(
    (key: string) => {
      const next = new Set(viewStateRef.current.collapsedGroups)
      if (!next.delete(key)) {
        next.add(key)
      }
      persistViewSettings({ collapsedGroups: [...next] })
    },
    [persistViewSettings]
  )
  const toggleWorktreeLineage = useCallback(
    (item: Worktree) => toggleCollapsed(getMobileWorkspaceLineageGroupKey(item)),
    [toggleCollapsed]
  )
  const { sections, rawSections, uniqueRepos, uniqueRepoColors } = useWorkspaceSections({
    displayWorktrees,
    sortMode,
    filters,
    search,
    groupMode,
    pinnedIds,
    repoIdsByName,
    repoColorsByName,
    collapsedGroups,
    workspaceStatuses
  })
  const existingWorktreePaths = useMemo(() => worktrees.map((w) => w.path), [worktrees])

  const { sectionListRef, onScrollToIndexFailed } = useActiveWorktreeScroll(sections)

  const isReadOnly = connState === 'auth-failed'

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    )
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.topChrome}>
        <View style={styles.statusBar}>
          <Pressable
            style={styles.backButton}
            onPress={shellOperations.leaveHost}
            accessibilityRole="button"
            accessibilityLabel="Back to hosts"
            hitSlop={8}
          >
            <ChevronLeft size={22} color={colors.textPrimary} />
          </Pressable>
          {(() => {
            const headerVerdict = classifyConnection({
              state: connState,
              reconnectAttempts,
              lastConnectedAt,
              ...relayRecovery
            })
            return (
              <>
                <View style={styles.hostIdentity}>
                  <StatusDot state={connState} verdict={headerVerdict} />
                  <Text style={styles.hostNameText} numberOfLines={1}>
                    {hostName || 'Host'}
                  </Text>
                </View>
                {connState !== 'connected' &&
                  (() => {
                    // Why: auth-failed has its own banner, so suppress the Reconnect button for that verdict.
                    const verdict = headerVerdict
                    const isError = isErrorVerdict(verdict)
                    const showReconnectButton = isError && hostId && verdict.kind !== 'auth-failed'
                    if (!showReconnectButton) {
                      return null
                    }
                    return (
                      <Pressable
                        style={styles.reconnectButton}
                        onPress={() => void shellOperations.reconnect()}
                        hitSlop={8}
                      >
                        <Text style={styles.reconnectButtonText}>Reconnect</Text>
                      </Pressable>
                    )
                  })()}
              </>
            )
          })()}
          {!embedded && floatingWorkspaceEnabled ? (
            <Pressable
              style={[
                styles.floatingWorkspaceHeaderButton,
                connState !== 'connected' && styles.toolbarIconDisabled
              ]}
              onPress={openFloatingWorkspace}
              disabled={connState !== 'connected'}
              accessibilityRole="button"
              accessibilityLabel="Floating Workspace"
              hitSlop={8}
            >
              <SquareTerminal
                size={18}
                color={connState === 'connected' ? colors.textPrimary : colors.textMuted}
              />
            </Pressable>
          ) : null}
          {embedded && onHideSidebar ? (
            <Pressable
              style={styles.sidebarCollapseButton}
              onPress={onHideSidebar}
              accessibilityRole="button"
              accessibilityLabel="Hide sidebar"
              hitSlop={8}
            >
              <PanelLeftClose size={14} color={colors.textSecondary} />
            </Pressable>
          ) : null}
        </View>

        {/* Filter/sort/group toolbar */}
        {embedded ? (
          <View style={styles.embeddedToolbar}>
            <View style={styles.embeddedToolbarRow}>
              <Pressable
                style={[
                  styles.filterChip,
                  styles.embeddedFilterChip,
                  activeFilterCount > 0 && styles.filterChipActive
                ]}
                onPress={() => setShowFilterModal(true)}
                accessibilityRole="button"
                accessibilityLabel={`Filter workspaces${activeFilterCount > 0 ? `, ${activeFilterCount} active` : ''}`}
              >
                <Filter
                  size={12}
                  color={activeFilterCount > 0 ? colors.textPrimary : colors.textSecondary}
                />
                <Text
                  style={[
                    styles.filterChipText,
                    activeFilterCount > 0 && styles.filterChipTextActive
                  ]}
                  numberOfLines={1}
                >
                  Filter{activeFilterCount > 0 ? ` ${activeFilterCount}` : ''}
                </Text>
              </Pressable>

              <Pressable
                style={[styles.modeButton, styles.embeddedModeButton]}
                onPress={() => setShowSortPicker(true)}
                accessibilityRole="button"
                accessibilityLabel={`Sort by ${selectedSortLabel}`}
              >
                <SlidersHorizontal size={14} color={colors.textSecondary} />
                <Text style={styles.sortLabel} numberOfLines={1}>
                  {selectedSortLabel}
                </Text>
              </Pressable>

              <Pressable
                style={[styles.modeButton, styles.embeddedModeButton]}
                onPress={() => setShowGroupPicker(true)}
                accessibilityRole="button"
                accessibilityLabel="Group workspaces"
              >
                <Layers size={14} color={colors.textSecondary} />
                <Text style={styles.sortLabel} numberOfLines={1}>
                  {groupMode === 'none'
                    ? 'Group'
                    : groupMode === 'workspaceStatus'
                      ? 'Status'
                      : groupMode === 'repo'
                        ? 'Repo'
                        : 'PR'}
                </Text>
              </Pressable>
            </View>

            <View style={styles.embeddedToolbarRow}>
              <Pressable
                style={[
                  styles.embeddedToolbarIconButton,
                  connState !== 'connected' && styles.toolbarIconDisabled
                ]}
                onPress={() => navigateFromHostList(`/h/${hostId}/accounts`)}
                disabled={connState !== 'connected'}
                accessibilityRole="button"
                accessibilityLabel="Accounts"
              >
                <UserCircle
                  size={16}
                  color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
                />
              </Pressable>

              <Pressable
                style={[
                  styles.embeddedToolbarIconButton,
                  connState !== 'connected' && styles.toolbarIconDisabled
                ]}
                onPress={() => navigateFromHostList(`/h/${hostId}/tasks`)}
                disabled={connState !== 'connected'}
                accessibilityRole="button"
                accessibilityLabel="Tasks"
              >
                <List
                  size={16}
                  color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
                />
              </Pressable>

              {floatingWorkspaceEnabled ? (
                <Pressable
                  style={[
                    styles.embeddedToolbarIconButton,
                    connState !== 'connected' && styles.toolbarIconDisabled
                  ]}
                  onPress={openFloatingWorkspace}
                  disabled={connState !== 'connected'}
                  accessibilityRole="button"
                  accessibilityLabel="Floating Workspace"
                >
                  <SquareTerminal
                    size={18}
                    color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
                  />
                </Pressable>
              ) : null}

              <Pressable
                style={[
                  styles.embeddedToolbarIconButton,
                  connState !== 'connected' && styles.toolbarIconDisabled
                ]}
                onPress={openNewWorktreeModal}
                disabled={connState !== 'connected'}
                accessibilityRole="button"
                accessibilityLabel="New workspace"
              >
                <Plus
                  size={16}
                  color={connState === 'connected' ? colors.textPrimary : colors.textMuted}
                />
              </Pressable>

              <Pressable
                style={styles.embeddedToolbarIconButton}
                onPress={() => setShowSearch((s) => !s)}
                accessibilityRole="button"
                accessibilityLabel={showSearch ? 'Close search' : 'Search workspaces'}
              >
                {showSearch ? (
                  <X size={16} color={colors.textSecondary} />
                ) : (
                  <Search size={16} color={colors.textSecondary} />
                )}
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.toolbar}>
            <Pressable
              style={[styles.filterChip, activeFilterCount > 0 && styles.filterChipActive]}
              onPress={() => setShowFilterModal(true)}
            >
              <Filter
                size={12}
                color={activeFilterCount > 0 ? colors.textPrimary : colors.textSecondary}
              />
              <Text
                style={[
                  styles.filterChipText,
                  activeFilterCount > 0 && styles.filterChipTextActive
                ]}
              >
                Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
              </Text>
            </Pressable>

            <Pressable style={styles.modeButton} onPress={() => setShowSortPicker(true)}>
              <SlidersHorizontal size={14} color={colors.textSecondary} />
              <Text style={styles.sortLabel} numberOfLines={1}>
                {selectedSortLabel}
              </Text>
            </Pressable>

            <Pressable style={styles.modeButton} onPress={() => setShowGroupPicker(true)}>
              <Layers size={14} color={colors.textSecondary} />
              <Text style={styles.sortLabel} numberOfLines={1}>
                {groupMode === 'none'
                  ? 'Group'
                  : groupMode === 'workspaceStatus'
                    ? 'Status'
                    : groupMode === 'repo'
                      ? 'Repo'
                      : 'PR'}
              </Text>
            </Pressable>

            <View style={styles.toolbarSpacer} />

            <Pressable
              style={styles.searchToggle}
              onPress={() => navigateFromHostList(`/h/${hostId}/accounts`)}
              disabled={connState !== 'connected'}
            >
              <UserCircle
                size={16}
                color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
              />
            </Pressable>

            <Pressable
              style={styles.searchToggle}
              onPress={() => navigateFromHostList(`/h/${hostId}/tasks`)}
              disabled={connState !== 'connected'}
              accessibilityRole="button"
              accessibilityLabel="Tasks"
            >
              <List
                size={16}
                color={connState === 'connected' ? colors.textSecondary : colors.textMuted}
              />
            </Pressable>

            <Pressable style={styles.searchToggle} onPress={() => setShowSearch((s) => !s)}>
              {showSearch ? (
                <X size={16} color={colors.textSecondary} />
              ) : (
                <Search size={16} color={colors.textSecondary} />
              )}
            </Pressable>
          </View>
        )}
      </View>

      {/* Auth failed: a latched relay rejection must reach the same re-pair affordance. */}
      {(connState === 'auth-failed' || relayRecovery.pairingRejected) && (
        <AuthFailedBanner
          canRetry={!!hostId}
          onRetry={() => hostId && void shellOperations.reconnect()}
          onRepair={shellOperations.repairPairing}
          onRemove={() => setConfirmRemoveHost(true)}
        />
      )}

      {connState !== 'connected' &&
      !relayRecovery.pairingRejected &&
      reconnectAttempts >= 3 &&
      hostId ? (
        <HostDiagnosticsLink
          onPress={() =>
            navigateFromHostList(`/connection-log?hostId=${encodeURIComponent(hostId)}`)
          }
        />
      ) : null}

      {/* Why a bounced route landed here (e.g. the workspace was deleted on the desktop). */}
      {routeNotice && (
        <HostRouteNoticeBanner
          message={routeNotice}
          onDismiss={() => setDismissedNotice(noticeParam ?? null)}
        />
      )}

      {/* Search bar */}
      {showSearch && (
        <View style={styles.searchBar}>
          <MobileSearchField
            value={search}
            onChangeText={setSearch}
            placeholder="Search worktrees…"
            autoFocus
            // Why: new key per open remounts the focus effect across rapid toggles so the keyboard reappears.
            focusKey={showSearch}
            accessibilityLabel="Search worktrees"
          />
        </View>
      )}

      <HostWorkspaceListStates
        connState={connState}
        worktreesLoaded={worktreesLoaded}
        displayCount={displayWorktrees.length}
        sectionCount={sections.length}
        catalogError={catalogError}
        search={search}
        activeFilterCount={activeFilterCount}
      />

      {sections.length > 0 && (
        <SectionList
          ref={sectionListRef}
          sections={sections}
          keyExtractor={(w) => w.sectionListKey ?? getWorktreeRowIdentity(w)}
          stickySectionHeadersEnabled={false}
          // Why: keep the search IME up while tapping clear / scrolling results.
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onScrollToIndexFailed={onScrollToIndexFailed}
          // Why: edge-to-edge under the system nav bar; insets.bottom keeps the last row above it.
          contentContainerStyle={[
            styles.list,
            // Reserve room so the last row stays tappable above the phone's floating "+" (embedded uses the toolbar +).
            { paddingBottom: (embedded ? spacing.lg : FAB_SIZE + spacing.xl) + insets.bottom },
            isWideLayout &&
              !embedded && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }
          ]}
          renderSectionHeader={({ section }) => {
            if (!section.title) {
              return null
            }
            const isCollapsed = collapsedGroups.has(section.key)
            const rawSection = rawSections.find((s) => s.key === section.key)
            const count = rawSection?.data.length ?? 0
            const repoSectionColor =
              groupMode === 'repo' ? uniqueRepoColors.get(section.title) : null
            const repoSectionIcon = groupMode === 'repo' ? repoIconsByName.get(section.title) : null
            return (
              <Pressable style={styles.sectionHeader} onPress={() => toggleCollapsed(section.key)}>
                {isCollapsed ? (
                  <ChevronRight size={12} color={colors.textMuted} style={styles.sectionIcon} />
                ) : (
                  <ChevronDown size={12} color={colors.textMuted} style={styles.sectionIcon} />
                )}
                {section.icon === 'pin' && (
                  <Pin size={12} color={colors.textMuted} style={styles.sectionIcon} />
                )}
                {groupMode === 'repo' ? (
                  <View style={styles.sectionRepoIcon}>
                    <MobileRepoIcon
                      repoIcon={repoSectionIcon}
                      size={14}
                      color={repoSectionColor ?? colors.textSecondary}
                    />
                  </View>
                ) : null}
                <Text style={styles.sectionTitle}>{section.title}</Text>
                <Text style={styles.sectionCount}>{count}</Text>
              </Pressable>
            )
          }}
          ItemSeparatorComponent={ListSeparator}
          // Why (#8498): manual pull-to-refresh forces a fresh snapshot after a stale-cache reconnect.
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.textSecondary}
              colors={[colors.textSecondary]}
            />
          }
          renderItem={({ item }) => (
            <WorktreeListRow
              item={item}
              isReadOnly={isReadOnly}
              now={now}
              status={getWorktreeStatus(item)}
              repoColor={uniqueRepoColors.get(item.repo) ?? repoColor(item.repo)}
              repoIcon={repoIconsByName.get(item.repo) ?? null}
              hideRepo={groupMode === 'repo'}
              onPress={openWorktreeSession}
              onLongPress={item.workspaceKind === 'folder-workspace' ? undefined : setActionTarget}
              onToggleLineage={toggleWorktreeLineage}
            />
          )}
        />
      )}

      {/* Floating "new workspace" button — phone only; embedded sidebars keep the toolbar +. */}
      {!embedded && (
        <NewWorkspaceFab onPress={openNewWorktreeModal} disabled={connState !== 'connected'} />
      )}

      <PickerModal
        visible={showSortPicker}
        title="Sort By"
        options={SORT_OPTIONS}
        selected={sortMode}
        onSelect={handleSortChange}
        onClose={() => setShowSortPicker(false)}
      />

      <PickerModal
        visible={showGroupPicker}
        title="Group By"
        options={GROUP_OPTIONS}
        selected={groupMode}
        onSelect={handleGroupChange}
        onClose={() => setShowGroupPicker(false)}
      />

      <BottomDrawer visible={showFilterModal} onClose={() => setShowFilterModal(false)}>
        <View style={styles.filterModalHeader}>
          <Text style={styles.filterModalTitle}>Filter</Text>
          {activeFilterCount > 0 && (
            <Pressable onPress={clearFilters}>
              <Text style={styles.clearFiltersText}>Clear filters</Text>
            </Pressable>
          )}
        </View>

        <Text style={styles.filterSectionLabel}>Workspaces</Text>
        <View style={styles.filterGroup}>
          <Pressable style={styles.filterRow} onPress={toggleHideSleeping}>
            <Text style={styles.filterRowText}>Hide sleeping</Text>
            {filters.hideSleeping && <Check size={14} color={colors.textPrimary} />}
          </Pressable>
          <View style={styles.filterSeparator} />
          <Pressable style={styles.filterRow} onPress={toggleHideDefaultBranch}>
            <Text style={styles.filterRowText}>Hide default branch</Text>
            {filters.hideDefaultBranch && <Check size={14} color={colors.textPrimary} />}
          </Pressable>
        </View>

        {uniqueRepos.length > 1 && (
          <>
            <Text style={styles.filterSectionLabel}>Repositories</Text>
            <View style={styles.filterGroup}>
              {uniqueRepos.map((repo, i) => (
                <View key={repo.id}>
                  {i > 0 && <View style={styles.filterSeparator} />}
                  <Pressable style={styles.filterRow} onPress={() => toggleRepoFilter(repo.id)}>
                    <View style={[styles.filterRepoDot, { backgroundColor: repo.color }]} />
                    <Text style={styles.filterRowText} numberOfLines={1}>
                      {repo.name}
                    </Text>
                    {filters.filterRepoIds.has(repo.id) && (
                      <Check size={14} color={colors.textPrimary} />
                    )}
                  </Pressable>
                </View>
              ))}
            </View>
          </>
        )}
      </BottomDrawer>

      {/* Worktree long-press action sheet (inline confirm to avoid double-Modal lag) */}
      <BottomDrawer
        visible={actionTarget != null}
        onClose={() => {
          setConfirmDelete(null)
          setActionTarget(null)
        }}
      >
        {confirmDelete ? (
          <View>
            <View style={styles.confirmContent}>
              <Text style={styles.confirmTitle}>Delete Worktree</Text>
              <Text style={styles.confirmMessage}>
                Delete "{confirmDelete.displayName || confirmDelete.repo}" ({confirmDelete.branch})?
              </Text>
            </View>
            <View style={styles.confirmButtons}>
              <Pressable
                style={({ pressed }) => [
                  styles.confirmBtn,
                  styles.confirmBtnCancel,
                  pressed && styles.confirmBtnPressed
                ]}
                onPress={() => setConfirmDelete(null)}
              >
                <Text style={styles.confirmBtnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.confirmBtn,
                  styles.confirmBtnDestructive,
                  pressed && styles.confirmBtnPressed
                ]}
                onPress={() => {
                  if (confirmDelete) {
                    void handleDeleteWorktree(confirmDelete)
                  }
                  setConfirmDelete(null)
                  setActionTarget(null)
                }}
              >
                <Text style={styles.confirmBtnDestructiveText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <ActionSheetContent
            title={actionTarget ? actionTarget.displayName || actionTarget.repo : undefined}
            message={actionTarget?.branch}
            actions={
              actionTarget
                ? [
                    ...buildWorktreeNavigationActions({
                      hostId,
                      worktreeId: actionTarget.worktreeId,
                      worktreeName: actionTarget.displayName || actionTarget.repo,
                      hostCapabilities,
                      navigate: navigateFromHostList,
                      onDone: () => setActionTarget(null)
                    }),
                    {
                      label: 'Sleep',
                      icon: Moon,
                      onPress: () => {
                        if (workspaceOperations) {
                          setSleptIds((prev) =>
                            new Set(prev).add(getWorktreeRowIdentity(actionTarget))
                          )
                          void workspaceOperations
                            .sleepWorkspace(actionTarget.worktreeId)
                            .catch(() => null)
                        }
                        setActionTarget(null)
                      }
                    },
                    {
                      label: isWorktreePinned(actionTarget, pinnedIds) ? 'Unpin' : 'Pin',
                      onPress: () => {
                        togglePin(actionTarget.worktreeId)
                        setActionTarget(null)
                      }
                    },
                    {
                      label: 'Delete',
                      destructive: true,
                      onPress: () => setConfirmDelete(actionTarget)
                    }
                  ]
                : []
            }
          />
        )}
      </BottomDrawer>

      {/* Host remove confirmation */}
      <ConfirmModal
        visible={confirmRemoveHost}
        title="Remove Host"
        message={`Remove "${hostName}"? You can re-pair later.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => void handleRemoveHost()}
        onCancel={() => setConfirmRemoveHost(false)}
      />

      <NewWorktreeModalController
        ref={newWorktreeModalRef}
        routeVisible={showNewWorktree}
        operations={workspaceCreationOperations}
        hostId={hostId}
        existingWorktreePaths={existingWorktreePaths}
        existingWorktrees={worktrees}
        openExternalUrl={shellOperations.openExternalUrl}
        onVisibleChange={(visible) => {
          newWorktreeModalVisibleRef.current = visible
        }}
        onCreated={(worktreeId, worktreeName) => {
          void fetchWorktrees({ allowDuringModal: true })
          navigateFromHostList(hostNewWorktreeSessionRoute(hostId, worktreeId, worktreeName))
        }}
        onRouteVisibleChange={setShowNewWorktreeVisible}
      />
    </SafeAreaView>
  )
}

// On wide layouts the sidebar hosts the list, so this route is just the empty detail pane.
export default function HostWorktreeRoute() {
  const { isWideLayout } = useResponsiveLayout()
  if (isWideLayout) {
    return <WorkspaceDetailPlaceholder />
  }
  return <HostScreen />
}

function ListSeparator() {
  return <View style={styles.separator} />
}
