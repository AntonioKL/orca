import { useCallback } from 'react'
import { useAppStore } from '../../store'
import { EMPTY_LAYOUT } from './layout-serialization'
import { resolveTerminalLayoutActiveLeafId } from './terminal-layout-leaf-ids'
import { useExpandCollapseActions } from './expand-collapse'
import type { TerminalPaneLayoutController } from './use-terminal-pane-layout-persistence'

export function useTerminalPaneLayoutBindings(controller: TerminalPaneLayoutController) {
  const {
    containerRef,
    expandedPaneIdRef,
    expandedStyleSnapshotRef,
    managerRef,
    pendingPaneSizeRefreshFrameIdsRef,
    persistLayoutSnapshot,
    setExpandedPaneId,
    setTabLayout,
    setTabPaneExpanded,
    tabId
  } = controller
  const writePanePtyLayoutBinding = useCallback(
    (paneId: number, ptyId: string | null, repairActiveLeafOnClear: boolean): void => {
      const existingLayout = useAppStore.getState().terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT
      const { ptyIdsByLeafId: _existingPtyIdsByLeafId, ...layoutWithoutPtyBindings } =
        existingLayout
      const existingBindings = existingLayout.ptyIdsByLeafId ?? {}
      const leafId = managerRef.current?.getLeafId(paneId)
      if (!leafId) {
        return
      }
      if (ptyId) {
        setTabLayout(tabId, {
          ...layoutWithoutPtyBindings,
          ptyIdsByLeafId: { ...existingBindings, [leafId]: ptyId }
        })
        return
      }
      const nextBindings = { ...existingBindings }
      delete nextBindings[leafId]
      const nextLayout = {
        ...layoutWithoutPtyBindings,
        ...(Object.keys(nextBindings).length > 0 ? { ptyIdsByLeafId: nextBindings } : {})
      }
      if (
        repairActiveLeafOnClear &&
        existingLayout.activeLeafId === leafId &&
        Object.keys(nextBindings).length > 0
      ) {
        nextLayout.activeLeafId = resolveTerminalLayoutActiveLeafId({
          root: nextLayout.root,
          activeLeafId: nextLayout.activeLeafId,
          ptyIdsByLeafId: nextBindings
        })
      }
      setTabLayout(tabId, nextLayout)
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [setTabLayout, tabId]
  )
  const syncPanePtyLayoutBinding = useCallback(
    (paneId: number, ptyId: string | null): void => {
      writePanePtyLayoutBinding(paneId, ptyId, false)
    },
    [writePanePtyLayoutBinding]
  )
  const clearExitedPanePtyLayoutBinding = useCallback(
    (paneId: number, exitedPtyId: string): void => {
      const existingLayout = useAppStore.getState().terminalLayoutsByTabId[tabId] ?? EMPTY_LAYOUT
      const { ptyIdsByLeafId: _existingPtyIdsByLeafId, ...layoutWithoutPtyBindings } =
        existingLayout
      const existingBindings = existingLayout.ptyIdsByLeafId ?? {}
      const leafId = managerRef.current?.getLeafId(paneId)
      if (!leafId || existingBindings[leafId] !== exitedPtyId) {
        return
      }
      const nextBindings = { ...existingBindings }
      delete nextBindings[leafId]
      setTabLayout(tabId, {
        ...layoutWithoutPtyBindings,
        activeLeafId: resolveTerminalLayoutActiveLeafId({
          root: existingLayout.root,
          activeLeafId: existingLayout.activeLeafId,
          ptyIdsByLeafId: nextBindings
        }),
        ...(Object.keys(nextBindings).length > 0 ? { ptyIdsByLeafId: nextBindings } : {})
      })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
    [setTabLayout, tabId]
  )

  const {
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    syncExpandedLayout,
    toggleExpandPane
  } = useExpandCollapseActions({
    expandedPaneIdRef,
    expandedStyleSnapshotRef,
    containerRef,
    managerRef,
    pendingPaneSizeRefreshFrameIdsRef,
    setExpandedPaneId,
    setTabPaneExpanded,
    tabId,
    persistLayoutSnapshot
  })

  return {
    writePanePtyLayoutBinding,
    syncPanePtyLayoutBinding,
    clearExitedPanePtyLayoutBinding,
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    syncExpandedLayout,
    toggleExpandPane
  }
}

export type TerminalPaneBindingController = TerminalPaneLayoutController &
  ReturnType<typeof useTerminalPaneLayoutBindings>
