import { useEffect } from 'react'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'

export function useAutomationsPageEscape({
  store,
  local
}: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
}): void {
  const { activeModal, closeAutomationsPage } = store
  const {
    createOpen,
    deleteTarget,
    externalDeleteTarget,
    isDetailOpen,
    selectedAutomationRunPageId,
    selectedExternalRunPage,
    setActivePaneTab,
    setIsDetailOpen,
    setSelectedAutomationRunPageId,
    setSelectedExternalRunPage
  } = local
  useEffect(() => {
    if (createOpen || deleteTarget || externalDeleteTarget || activeModal !== 'none') {
      return
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }

      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      // Popovers and menus are outside the store modal registry and own Escape.
      if (hasVisibleOverlay()) {
        return
      }

      if (target.dataset.escapeClearsValue === 'true') {
        return
      }

      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      ) {
        event.preventDefault()
        target.blur()
        return
      }

      if (isDetailOpen) {
        event.preventDefault()
        if (selectedExternalRunPage) {
          setSelectedExternalRunPage(null)
          return
        }
        if (selectedAutomationRunPageId) {
          setSelectedAutomationRunPageId(null)
          return
        }
        setIsDetailOpen(false)
        setActivePaneTab('overview')
        return
      }

      event.preventDefault()
      closeAutomationsPage()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    activeModal,
    closeAutomationsPage,
    createOpen,
    deleteTarget,
    externalDeleteTarget,
    isDetailOpen,
    selectedAutomationRunPageId,
    selectedExternalRunPage,
    setActivePaneTab,
    setIsDetailOpen,
    setSelectedAutomationRunPageId,
    setSelectedExternalRunPage
  ])
}
