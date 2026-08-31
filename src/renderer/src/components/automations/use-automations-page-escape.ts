import { useEffect } from 'react'
import type { AutomationsPageLocalState } from './use-automations-page-local-state'
import type { AutomationsPageStoreState } from './use-automations-page-store-state'

export function useAutomationsPageEscape({
  store,
  local
}: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
}): void {
  const { closeAutomationsPage } = store
  const { createOpen, deleteTarget, externalDeleteTarget } = local
  useEffect(() => {
    if (createOpen || deleteTarget || externalDeleteTarget) {
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

      event.preventDefault()
      closeAutomationsPage()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [closeAutomationsPage, createOpen, deleteTarget, externalDeleteTarget])
}
