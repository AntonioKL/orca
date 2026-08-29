import { useCallback, useRef, useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { showShutdownCheckpointFailureToast } from '@/lib/shutdown-checkpoint-failure-toast'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { useAppStore } from '@/store'
import { runWithWindowCloseCheckpointScope } from '../window-close-request-coordinator'
import { anyPtyBlocksWindowClose } from './window-close-running-process-evidence'
import { RUNNING_CLOSE_PROBE_TIMEOUT_MS } from './running-terminal-close-guard'

export type WindowCloseRunningProcessPrompt = {
  /** Probes the window's PTYs on their execution hosts, then raises the confirmation or closes. */
  proceedToNativeWindowClose: (isQuitting: boolean) => void
  windowCloseDialog: ReactElement
}

/**
 * The window-close confirmation, shown for any terminal with running children.
 * Direct-SSH panes are probed on their execution host rather than skipped: their
 * shell does not survive the window, so treating "runs elsewhere" as "not ours to
 * warn about" closed over live remote work. Owns the probe, the decision and the
 * dialog together so the decision is only ever reachable through the surface the
 * user actually sees.
 */
export function useWindowCloseRunningProcessPrompt(): WindowCloseRunningProcessPrompt {
  const [windowCloseDialogOpen, setWindowCloseDialogOpen] = useState(false)
  const closeRequestSeqRef = useRef(0)

  /** Ends the current attempt. Why the bump and not just the state: the newest
   *  attempt is not the newest intent — a probe still outstanding when the user
   *  dismisses belongs to a close they have since called off, and letting it
   *  decide closes the window they just chose to keep. */
  const dismissWindowCloseDialog = useCallback(() => {
    closeRequestSeqRef.current += 1
    setWindowCloseDialogOpen(false)
  }, [])

  const confirmNativeWindowClose = useCallback(() => {
    // Why: capture only after every close guard has committed. A canceled child-
    // process prompt must not consume App's synthetic/native unload guard.
    const accepted = runWithWindowCloseCheckpointScope(() =>
      window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
    )
    if (!accepted) {
      // Why: a checkpoint-vetoed quit used to die here with no dialog and no log,
      // leaving SIGKILL as the only exit (#15352). The dirty-file veto publishes
      // no reason — its deferred dialog flow already gives the user a surface.
      showShutdownCheckpointFailureToast()
      return
    }
    window.api.ui.confirmWindowClose()
  }, [])

  const proceedToNativeWindowClose = useCallback(
    (isQuitting: boolean) => {
      if (!isQuitting) {
        const state = useAppStore.getState()
        // Why no owning-host filter: `inspectProcess` dispatches on the PTY id, so
        // each pane is answered by whichever host runs it. Selecting local worktrees
        // here discarded every direct-SSH pane unprobed, and discarded a worktree
        // whose repo had not hydrated yet as though it were remote.
        const ptyIds = Object.values(state.tabsByWorktree).flatMap((worktreeTabs) =>
          worktreeTabs
            .flatMap((tab) => state.ptyIdsByTabId[tab.id] ?? [])
            // Runtime-environment panes stay out: they are owned by a host this
            // window is only a viewer of, and outlive it by design.
            .filter((ptyId) => !isRemoteRuntimePtyId(ptyId))
        )
        if (ptyIds.length > 0) {
          // Why the same bound as the tab and pane close paths: an unanswered probe
          // must not leave the window silently stuck (#10142).
          // Why a generation and not an in-flight flag: main re-sends
          // window:close-requested on every attempt (main-window-close-lifecycle.ts) and
          // nothing upstream fences the probe, so two can be outstanding at once. Only the
          // newest may decide — an older answer would reopen a dialog the user dismissed,
          // or close the window they just chose to keep.
          const requestSeq = (closeRequestSeqRef.current += 1)
          void anyPtyBlocksWindowClose(state.settings, ptyIds, RUNNING_CLOSE_PROBE_TIMEOUT_MS).then(
            (blocked) => {
              if (requestSeq !== closeRequestSeqRef.current) {
                return
              }
              if (blocked) {
                setWindowCloseDialogOpen(true)
              } else {
                confirmNativeWindowClose()
              }
            }
          )
          return
        }
      }
      confirmNativeWindowClose()
    },
    [confirmNativeWindowClose]
  )

  const windowCloseDialog = (
    <Dialog
      open={windowCloseDialogOpen}
      onOpenChange={(open) => {
        if (!open) {
          dismissWindowCloseDialog()
        }
      }}
    >
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.Terminal.2fa9c69ff3', 'Close Window?')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.Terminal.7958465754',
              'There are terminals with running processes. Close the window anyway?'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={dismissWindowCloseDialog}>
            {translate('auto.components.Terminal.f82e9f02df', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            autoFocus
            onClick={() => {
              dismissWindowCloseDialog()
              confirmNativeWindowClose()
            }}
          >
            {translate('auto.components.Terminal.73768427cf', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return { proceedToNativeWindowClose, windowCloseDialog }
}
