import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { createOsc52OscHandler } from './osc52-clipboard'
import {
  showOsc52ClipboardBlockedToast,
  showOsc52ClipboardFailedToast
} from './osc52-clipboard-toast'
import { parseOsc7 } from './parse-osc7'
import { guardParserHandler } from './terminal-parser-handler-guard'
import { isPaneReplaying } from './replay-guard'
import { connectPanePty } from './pty-connection'
import {
  createQueuedStartupConsumer,
  resolvePaneSeedCwd,
  clearQueuedInitialCwdAfterFirstPane
} from './terminal-pane-lifecycle-primitives'
import type { TerminalPaneManagerOptionsContext } from './terminal-pane-mount-context'
import { installTerminalPaneInputHandling } from './terminal-pane-pane-input'
import { installTerminalPaneLinkHandling } from './terminal-pane-pane-links'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'

export type PaneCreatedSetupContext = TerminalPaneManagerOptionsContext

/** Creates the PaneManager `onPaneCreated` callback. */
export function createTerminalPaneCreatedHandler(
  context: PaneCreatedSetupContext
): (pane: ManagedPane, spawnHints?: { cwd?: string; ptyId?: string }) => void {
  return (pane, spawnHints) => {
    const { deps, refs, ptyDeps, startupWithSetupSplitWait, startup, osc7UncHost } = context
    const manager = deps.managerRef.current
    if (!manager) {
      return
    }
    const { settingsRef, paneCwdRef, paneKittyKeyboardModesRef, replayingPanesRef, managerRef } =
      deps

    const osc52Disposable = pane.terminal.parser.registerOscHandler(
      52,
      guardParserHandler(
        'osc-52-clipboard',
        createOsc52OscHandler({
          getSettingEnabled: () => settingsRef.current?.terminalAllowOsc52Clipboard,
          getReplaying: () => isPaneReplaying(replayingPanesRef, pane.id),
          writeClipboardText: (text) => window.api.ui.writeTerminalClipboardText(text),
          showBlockedWriteToast: showOsc52ClipboardBlockedToast,
          showWriteFailedToast: showOsc52ClipboardFailedToast
        })
      )
    )
    refs.osc52DisposablesRef.current.set(pane.id, osc52Disposable)

    if (!paneCwdRef.current.has(pane.id)) {
      paneCwdRef.current.set(pane.id, {
        cwd: resolvePaneSeedCwd(spawnHints?.cwd, ptyDeps.cwd ?? ''),
        confirmed: false
      })
    }
    const osc7Disposable = pane.terminal.parser.registerOscHandler(
      7,
      guardParserHandler('osc-7-cwd', (data) => {
        const parsedCwd = parseOsc7(data, { uncHost: osc7UncHost })
        if (parsedCwd) {
          paneCwdRef.current.set(pane.id, {
            cwd: parsedCwd,
            confirmed: !isPaneReplaying(replayingPanesRef, pane.id)
          })
        }
        return true
      })
    )
    refs.osc7DisposablesRef.current.set(pane.id, osc7Disposable)

    installTerminalPaneInputHandling({
      pane,
      managerRef,
      paneKittyKeyboardModesRef,
      settingsRef,
      imeCompositionDisposablesRef: refs.imeCompositionDisposablesRef,
      imeNativeTextForwarderDisposablesRef: refs.imeNativeTextForwarderDisposablesRef
    })
    installTerminalPaneLinkHandling({
      pane,
      managerRef,
      settingsRef,
      refs,
      linkDeps: context.linkDeps,
      fileOpenLinkHint: context.fileOpenLinkHint,
      requestOpenLinksInAppPreference: context.requestOpenLinksInAppPreference,
      getHttpLinkSourceOwnerForPane: context.getHttpLinkSourceOwnerForPane,
      getHttpLinkActionDestinations: context.getHttpLinkActionDestinations,
      getLinkActionContext: context.getLinkActionContext,
      getPaneLinkCwd: context.getPaneLinkCwd,
      getUrlOpenLinkHint: context.getUrlOpenLinkHint,
      onShowSessionRestoredBanner: context.onShowSessionRestoredBanner,
      ptyStartup: ptyDeps.startup
    })

    context.applyAppearance(manager)
    const onQueuedStartupSpawned = createQueuedStartupConsumer(
      ptyDeps.startup,
      startupWithSetupSplitWait,
      () => useAppStore.getState().consumeTabStartupCommand(deps.tabId),
      () => useAppStore.getState().pendingStartupByTabId[deps.tabId] === startup
    )
    const panePtyBinding = connectPanePty(pane, manager, {
      ...ptyDeps,
      ...(onQueuedStartupSpawned ? { onQueuedStartupSpawned } : {}),
      ...(spawnHints?.cwd ? { cwd: spawnHints.cwd } : {}),
      restoredPtyIdByLeafId: spawnHints?.ptyId
        ? { ...ptyDeps.restoredPtyIdByLeafId, [pane.leafId]: spawnHints.ptyId }
        : ptyDeps.restoredPtyIdByLeafId,
      restoredLeafId: pane.leafId
    })
    ptyDeps.startup = null
    const nextInitialCwdState = clearQueuedInitialCwdAfterFirstPane(
      refs.queuedInitialCwdRef.current,
      context.defaultTabCwd,
      ptyDeps.cwd ?? ''
    )
    refs.queuedInitialCwdRef.current = nextInitialCwdState.queuedInitialCwd
    ptyDeps.cwd = nextInitialCwdState.ptyCwd
    deps.panePtyBindingsRef.current.set(pane.id, panePtyBinding)
    context.syncPaneCount()
    scheduleRuntimeGraphSync()
    context.queueResizeAll(true)
  }
}
