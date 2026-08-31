import type { AutomationPaneTab } from './automation-page-state'

export type AutomationDetailTabArrowKey = 'ArrowLeft' | 'ArrowRight'

export function isAutomationDetailTabArrowKey(key: string): key is AutomationDetailTabArrowKey {
  return key === 'ArrowLeft' || key === 'ArrowRight'
}

export function shouldHandleAutomationDetailTabArrowKey(event: {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  nativeEvent?: { isComposing?: boolean }
  target?: EventTarget | null
}): boolean {
  if (
    !isAutomationDetailTabArrowKey(event.key) ||
    Boolean(event.nativeEvent?.isComposing) ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return false
  }

  const target = event.target
  if (target instanceof HTMLElement) {
    if (
      target.isContentEditable ||
      target.matches(
        'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]'
      )
    ) {
      return false
    }
    if (target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) {
      return false
    }
  }

  return true
}

export function getAutomationDetailNextTab(args: {
  currentTab: AutomationPaneTab
  key: AutomationDetailTabArrowKey
  canAccessRuns?: boolean
}): AutomationPaneTab | null {
  const { currentTab, key, canAccessRuns = true } = args
  if (key === 'ArrowRight') {
    if (currentTab === 'overview' && canAccessRuns) {
      return 'runs'
    }
    return null
  }
  if (key === 'ArrowLeft') {
    if (currentTab === 'runs') {
      return 'overview'
    }
    return null
  }
  return null
}
