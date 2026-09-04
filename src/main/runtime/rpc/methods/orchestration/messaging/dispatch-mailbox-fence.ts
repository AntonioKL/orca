import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isEquivalentPaneKey } from '../../../../orchestration/db/pane-key-match'

export const DISPATCH_FENCED_MESSAGE =
  'This Dispatch was re-attached to another worker; this process no longer owns its mailbox.'

export function dispatchFenced(): OrchestrationError {
  return new OrchestrationError('consumer_fenced', DISPATCH_FENCED_MESSAGE)
}

/** Delivery fencing is generic; a worker needs to hear that it lost the Dispatch, not the Run. */
export function asDispatchFence(error: unknown): unknown {
  return error instanceof OrchestrationError && error.code === 'consumer_fenced'
    ? dispatchFenced()
    : error
}

// Why: the handle lookup outranks the pane one, so without this a stale process still holding the
// row's handle would read and ack the mailbox of the pane the Dispatch was re-pointed at.
export function callerHoldsDispatchPane(
  dispatch: { assignee_pane_key: string | null },
  paneKey: string | undefined
): boolean {
  return (
    paneKey === undefined ||
    dispatch.assignee_pane_key === null ||
    isEquivalentPaneKey(dispatch.assignee_pane_key, paneKey)
  )
}
