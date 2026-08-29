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
import { useAppStore } from '@/store'
import { runWithWindowCloseCheckpointScope } from '../window-close-request-coordinator'
import {
  anyPtyBlocksWindowClose,
  collectWindowClosePtyIds
} from './window-close-running-process-evidence'
import { RUNNING_CLOSE_PROBE_TIMEOUT_MS } from './running-terminal-close-guard'

export type WindowCloseRunningProcessPrompt = {
  /** Probes the window's PTYs on their execution hosts, then raises the confirmation or closes.
   *  `localPtysSurviveQuit` comes from main (window:close-requested) — the renderer cannot see
   *  whether the daemon will keep this window's local shells past a quit. */
  proceedToNativeWindowClose: (isQuitting: boolean, localPtysSurviveQuit: boolean) => void
  windowCloseDialog: ReactElement
}

/**
 * The window-close confirmation, shown for any terminal with running children whose
 * work this close would end. Direct-SSH panes are probed on their execution host
 * rather than skipped: their shell does not survive the window, so treating "runs
 * elsewhere" as "not ours to warn about" closed over live remote work. A quit skips
 * the confirmation only while main reports the daemon will keep the local shells;
 * without it the same quit is what kills them. Owns the probe, the decision and the
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
    (isQuitting: boolean, localPtysSurviveQuit: boolean) => {
      // Why a generation and not an in-flight flag: main re-sends
      // window:close-requested on every attempt (main-window-close-lifecycle.ts) and
      // nothing upstream fences the probe, so two can be outstanding at once. Only the
      // newest may decide — an older answer would reopen a dialog the user dismissed,
      // or close the window they just chose to keep.
      // Why at the entry and not inside the probe branch: the paths that never probe
      // end the previous attempt just as surely. A quit whose shutdown checkpoint
      // vetoes it returns with the window still open, and an earlier probe left
      // current would then decide for a request that has already been answered.
      const requestSeq = (closeRequestSeqRef.current += 1)
      // Why a quit can still ask: quit's killAllPty() is a no-op only while the daemon
      // adapter owns the shells, and that state is not guaranteed — a daemon that threw,
      // failed open, or was replaced by the degraded provider leaves the children
      // parented to this process, so the same silent quit takes live work with it.
      // Only main can tell the two apart, and only its explicit yes skips the warning.
      if (!isQuitting || !localPtysSurviveQuit) {
        const state = useAppStore.getState()
        const ptyIds = collectWindowClosePtyIds(state, isQuitting)
        if (ptyIds.length > 0) {
          // Why the same bound as the tab and pane close paths: an unanswered probe
          // must not leave the window silently stuck (#10142).
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
