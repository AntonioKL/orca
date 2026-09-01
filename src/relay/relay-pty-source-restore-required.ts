import type { RelayDispatcher, RequestContext } from './dispatcher'
import type { RelayPtySourceDeliveryRecord } from './relay-pty-source-delivery-record'
import { registerCanceledPtySourceRetirement } from './relay-pty-source-activation'
import type { RelayPtySourceSendScheduler } from './relay-pty-source-send-scheduler'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

export type PtySourceRestoreDeps = Readonly<{
  dispatcher: RelayDispatcher
  onCapacity: (id: string) => void
  session: SshPtyConsumerSessionAdapter
  sender: RelayPtySourceSendScheduler
  deliveries: Map<string, RelayPtySourceDeliveryRecord>
}>

type RestoreRequired = Readonly<{ status: 'restoreRequired'; reason: string }>

/**
 * The PTY is live and only its delivery is unusable, so retire the delivery and tell the client to
 * open a new one. Never an absence verdict — see docs/reference/ssh-execution-boundary.md.
 */
export function requirePtySourceRestore(
  deps: PtySourceRestoreDeps,
  id: string,
  current: RelayPtySourceDeliveryRecord,
  context: RequestContext,
  reason: string
): RestoreRequired {
  deps.session.cancelDelivery(current.identity, `recovery-${reason}`)
  current.restoreRequired = true
  current.activating = false
  deps.sender.wakeSendWaiters(current)
  registerCanceledPtySourceRetirement(current, context, deps.deliveries, deps.onCapacity)
  return publishPtySourceRestoreRequired(deps, id, context, reason)
}

export function publishPtySourceRestoreRequired(
  deps: PtySourceRestoreDeps,
  id: string,
  context: RequestContext,
  reason: string
): RestoreRequired {
  const result = Object.freeze({ status: 'restoreRequired' as const, reason })
  context.onResponseSettled?.((settlement) => {
    if (settlement.ok) {
      deps.dispatcher.notifyClient(context.clientId, 'pty.restoreRequired', { id, reason })
    }
  })
  deps.onCapacity(id)
  return result
}
