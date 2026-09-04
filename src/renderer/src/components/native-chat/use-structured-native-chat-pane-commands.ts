import { useCallback, type KeyboardEventHandler, type RefObject } from 'react'
import { useAppStore } from '@/store'
import { formatShortcutLabel } from '@/hooks/useShortcutLabel'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import type { NativeChatComposerHandle } from './NativeChatComposer'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu,
  type NativeChatContextMenuActions
} from './use-native-chat-context-menu'
import { matchNativeChatSplitShortcut } from './native-chat-split-shortcut'
import { runNativeChatSplitTarget } from './native-chat-layout-actions'

export function useStructuredNativeChatPaneCommands({
  tabId,
  rootRef,
  composerRef,
  terminalPaneActions
}: {
  tabId: string
  rootRef: RefObject<HTMLDivElement | null>
  composerRef: RefObject<NativeChatComposerHandle | null>
  terminalPaneActions?: Omit<NativeChatContextMenuActions, 'onPaste'>
}) {
  const groupId = useAppStore((state) => {
    for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
      const tab = tabs.find((entry) => entry.id === tabId)
      if (tab) {
        return tab.groupId
      }
    }
    return undefined
  })
  const isWorkspaceChatTab = useAppStore((state) => {
    for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
      const tab = tabs.find((entry) => entry.id === tabId)
      if (tab) {
        return tab.contentType === 'agent-session'
      }
    }
    return false
  })
  const keybindings = useAppStore((state) => state.keybindings)
  const pasteClipboardIntoComposer = useNativeChatPasteBridge({ rootRef, composerRef })
  const contextMenu = useNativeChatContextMenu({
    rootRef,
    actions: {
      ...emptyNativeChatContextMenuActions,
      ...terminalPaneActions,
      onPaste: pasteClipboardIntoComposer
    },
    showTerminalPaneActions: terminalPaneActions !== undefined,
    splitShortcutLabels: {
      right: formatShortcutLabel('terminal.splitRight', keybindings),
      down: formatShortcutLabel('terminal.splitDown', keybindings)
    },
    workspaceLayout:
      groupId && isWorkspaceChatTab
        ? {
            unifiedTabId: tabId,
            groupId,
            shortcutLabels: {
              right: formatShortcutLabel('terminal.splitRight', keybindings),
              down: formatShortcutLabel('terminal.splitDown', keybindings)
            }
          }
        : undefined
  })
  const onKeyDownCapture = useCallback<KeyboardEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.repeat || !groupId) {
        return
      }
      const direction = matchNativeChatSplitShortcut(event, getShortcutPlatform(), keybindings)
      if (!direction) {
        return
      }
      let handled = false
      if (terminalPaneActions) {
        if (direction === 'right') {
          terminalPaneActions.onSplitRight()
        } else {
          terminalPaneActions.onSplitDown()
        }
        handled = true
      } else if (isWorkspaceChatTab) {
        handled = runNativeChatSplitTarget(
          { kind: 'workspace-tab', unifiedTabId: tabId, groupId },
          direction
        )
      }
      if (!handled) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
    },
    [groupId, isWorkspaceChatTab, keybindings, tabId, terminalPaneActions]
  )

  return { ...contextMenu, onKeyDownCapture }
}
