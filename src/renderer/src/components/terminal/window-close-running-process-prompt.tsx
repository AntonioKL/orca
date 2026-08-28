import { useCallback, useState, type ReactElement } from 'react'
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
import { getConnectionId } from '@/lib/connection-context'
import { showShutdownCheckpointFailureToast } from '@/lib/shutdown-checkpoint-failure-toast'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { useAppStore } from '@/store'
import { runWithWindowCloseCheckpointScope } from '../window-close-request-coordinator'
import { anyLocalPtyBlocksWindowClose } from './window-close-running-process-evidence'

export type WindowCloseRunningProcessPrompt = {
  /** Probes the window's local PTYs, then either raises the confirmation or closes. */
  proceedToNativeWindowClose: (isQuitting: boolean) => void
  windowCloseDialog: ReactElement
}

/**
 * The window-close confirmation, shown for local terminals with running children
 * (SSH terminals detach/persist via the relay). Owns the probe, the decision and
 * the dialog together so the decision is only ever reachable through the surface
 * the user actually sees.
 */
export function useWindowCloseRunningProcessPrompt(): WindowCloseRunningProcessPrompt {
  const [windowCloseDialogOpen, setWindowCloseDialogOpen] = useState(false)

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
        const localPtyIds = Object.entries(state.tabsByWorktree).flatMap(
          ([worktreeId, worktreeTabs]) => {
            const connectionId = getConnectionId(worktreeId)
            if (connectionId !== null) {
              return []
            }
            return worktreeTabs
              .flatMap((tab) => state.ptyIdsByTabId[tab.id] ?? [])
              .filter((ptyId) => !isRemoteRuntimePtyId(ptyId))
          }
        )
        if (localPtyIds.length > 0) {
          void anyLocalPtyBlocksWindowClose(state.settings, localPtyIds).then((blocked) => {
            if (blocked) {
              setWindowCloseDialogOpen(true)
            } else {
              confirmNativeWindowClose()
            }
          })
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
          setWindowCloseDialogOpen(false)
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
              'There are local terminals with running processes. Close the window anyway?'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setWindowCloseDialogOpen(false)}
          >
            {translate('auto.components.Terminal.f82e9f02df', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            autoFocus
            onClick={() => {
              setWindowCloseDialogOpen(false)
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
