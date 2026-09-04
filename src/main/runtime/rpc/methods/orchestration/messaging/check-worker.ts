import type { MessageType, OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { formatMessageBanner } from '../../../../orchestration/formatter'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../../../shared/orchestration-rpc-contract'
import { routeAllMailboxPages } from '../schemas'
import type { CheckParams } from '../schemas'
import type { z } from 'zod'

type CheckParamsInput = z.infer<typeof CheckParams>
type ActiveDispatch = NonNullable<ReturnType<OrchestrationDb['getActiveDispatchForIdentity']>>
type RemoteAttachment = NonNullable<
  ReturnType<OrchestrationDb['findActiveRemoteAttachmentForPane']>
>

// Why: a Dispatch mailbox has no consumer-generation counter of its own, and every identity that
// could stand in for one (the pane's PTY incarnation, the runtime id, dispatch_contexts
// .process_incarnation) is either read server-side from the handle — identical for both callers —
// or is never refreshed when a worker terminal restarts, which would fence the live worker out of
// its own mailbox. Fencing this mailbox needs a per-Dispatch generation bumped on attach, with the
// outstanding Delivery fenced at the same point (see runs/run-binding.ts). Until then the single
// constant keeps every consumer on one generation instead of wedging a restarted one.
const DISPATCH_MAILBOX_CONSUMER_GENERATION = 0

export async function checkWorkerMailbox(args: {
  params: CheckParamsInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  handle: string
  paneKey: string | undefined
  typeFilter: MessageType[] | undefined
  signal: AbortSignal | undefined
  activeDispatch: ActiveDispatch | undefined
  remoteAttachment: RemoteAttachment | undefined
}): Promise<unknown> {
  const {
    params,
    runtime,
    db,
    handle,
    paneKey,
    typeFilter,
    signal,
    activeDispatch,
    remoteAttachment
  } = args
  const workerMailbox = activeDispatch
    ? { dispatchId: activeDispatch.id, runId: activeDispatch.run_id }
    : remoteAttachment
      ? { dispatchId: remoteAttachment.dispatch_id, runId: undefined }
      : undefined
  if (!workerMailbox) {
    return undefined
  }
  const address = `dispatch:${workerMailbox.dispatchId}`
  const routeDirectSnapshot = async (
    runId: string,
    directHandle: string,
    routePage: (throughSequence: number) => { routedCount: number; hasMore: boolean }
  ): Promise<void> => {
    const throughSequence = db.getLatestUnreadDirectMessageSequenceForRun(runId, directHandle)
    if (throughSequence !== undefined) {
      await routeAllMailboxPages(() => routePage(throughSequence), signal)
    }
  }
  const revalidateWorkerMailbox = async (): Promise<void> => {
    if (activeDispatch) {
      const current = db.getActiveDispatchForIdentity(handle, paneKey)
      if (current?.id === activeDispatch.id) {
        return
      }
    } else if (remoteAttachment && paneKey) {
      const current = db.findActiveRemoteAttachmentForPane(paneKey)
      if (
        current?.dispatch_id === remoteAttachment.dispatch_id &&
        db.isRemoteAttachmentProcessCurrent({
          dispatchId: current.dispatch_id,
          paneKey,
          processIncarnation: runtime.getTerminalProcessIncarnation(handle)
        })
      ) {
        return
      }
    }
    const latestDispatch = db.getDispatchContextById(workerMailbox.dispatchId)
    const owningRunId = latestDispatch?.run_id ?? activeDispatch?.run_id ?? workerMailbox.runId
    if (
      owningRunId &&
      (!latestDispatch ||
        (latestDispatch.status !== 'pending' && latestDispatch.status !== 'dispatched'))
    ) {
      const throughSequence = db.getLatestUnreadMessageSequence(address)
      if (throughSequence !== undefined) {
        const routedTypes = new Set<MessageType>()
        const routePage = (): { routedCount: number; hasMore: boolean } => {
          const routed = db.routeUnreadDispatchMailboxToRunMailbox(
            workerMailbox.dispatchId,
            owningRunId,
            throughSequence
          )
          for (const routedType of routed.types) {
            routedTypes.add(routedType)
          }
          return routed
        }
        const notifyRoutedTypes = (): void => {
          for (const routedType of routedTypes) {
            runtime.notifyMessageArrived(`run:${owningRunId}`, routedType)
          }
          routedTypes.clear()
        }
        try {
          await routeAllMailboxPages(routePage, signal)
        } catch (error) {
          notifyRoutedTypes()
          if (error instanceof OrchestrationError && error.code === 'request_aborted') {
            setImmediate(() => {
              void routeAllMailboxPages(routePage)
                .catch(() => undefined)
                .finally(notifyRoutedTypes)
            })
          }
          throw error
        }
        notifyRoutedTypes()
      }
    }
    throw new OrchestrationError(
      'dispatch_inactive',
      `Dispatch ${workerMailbox.dispatchId} is no longer assigned to this worker.`
    )
  }

  if (activeDispatch) {
    await routeDirectSnapshot(activeDispatch.run_id, handle, (throughSequence) =>
      db.routeUnreadDirectMessagesToDispatchMailbox(
        activeDispatch.id,
        activeDispatch.run_id,
        handle,
        throughSequence
      )
    )
    const assigneeHandle = activeDispatch.assignee_handle
    if (assigneeHandle && assigneeHandle !== handle) {
      await routeDirectSnapshot(activeDispatch.run_id, assigneeHandle, (throughSequence) =>
        db.routeUnreadDirectMessagesToDispatchMailbox(
          activeDispatch.id,
          activeDispatch.run_id,
          assigneeHandle,
          throughSequence
        )
      )
    }
  }
  await revalidateWorkerMailbox()
  const deliveryRunId = workerMailbox.runId ?? ORCHESTRATION_LEGACY_RUN_ID
  const acknowledged = params.ack
    ? db.acknowledgeMailboxDelivery({
        runId: deliveryRunId,
        mailboxHandle: address,
        consumerGeneration: DISPATCH_MAILBOX_CONSUMER_GENERATION,
        deliveryId: params.ack
      })
    : undefined
  const showAll = params.all === true || (params.unread === false && params.peek !== true)
  const readPeek = () => db.getUnreadMessages(address, typeFilter)
  const readDelivery = (wakeTypes?: MessageType[]) =>
    db.getOrCreateMailboxDelivery({
      runId: deliveryRunId,
      mailboxHandle: address,
      consumerGeneration: DISPATCH_MAILBOX_CONSUMER_GENERATION,
      wakeTypes
    })
  if (showAll) {
    const messages = db.getAllMessagesForHandle(address, 100, typeFilter)
    return {
      ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
      dispatchId: workerMailbox.dispatchId,
      messages,
      count: messages.length,
      acknowledged: acknowledged?.delivery.id ?? null,
      ...(params.format || params.inject
        ? { formatted: messages.map(formatMessageBanner).join('\n\n') }
        : {})
    }
  }
  if (params.peek) {
    const messages = readPeek()
    if (messages.length > 0 || !params.wait) {
      return {
        ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
        dispatchId: workerMailbox.dispatchId,
        messages,
        count: messages.length,
        acknowledged: acknowledged?.delivery.id ?? null,
        ...(params.format || params.inject
          ? { formatted: messages.map(formatMessageBanner).join('\n\n') }
          : {})
      }
    }
  } else {
    const current = readDelivery(params.wait ? typeFilter : undefined)
    if (current || !params.wait) {
      return {
        ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
        dispatchId: workerMailbox.dispatchId,
        deliveryId: current?.delivery.id ?? null,
        messages: current?.messages ?? [],
        count: current?.messages.length ?? 0,
        replayed: current?.replayed ?? false,
        acknowledged: acknowledged?.delivery.id ?? null,
        timedOut: false,
        cancelled: false,
        connectionLost: false,
        ...(params.format || params.inject
          ? { formatted: current?.messages.map(formatMessageBanner).join('\n\n') ?? '' }
          : {})
      }
    }
  }
  const waitResult = await runtime.waitForMessage(address, {
    typeFilter: typeFilter as string[] | undefined,
    timeoutMs: params.timeoutMs ?? undefined,
    signal
  })
  await revalidateWorkerMailbox()
  if (waitResult === 'timed_out' || waitResult === 'cancelled') {
    return {
      ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
      dispatchId: workerMailbox.dispatchId,
      messages: [],
      count: 0,
      acknowledged: acknowledged?.delivery.id ?? null,
      timedOut: waitResult === 'timed_out',
      cancelled: waitResult === 'cancelled',
      connectionLost: waitResult === 'cancelled' && signal?.aborted === true
    }
  }
  if (params.peek) {
    const arrived = readPeek()
    return {
      ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
      dispatchId: workerMailbox.dispatchId,
      messages: arrived,
      count: arrived.length,
      acknowledged: acknowledged?.delivery.id ?? null,
      ...(params.format || params.inject
        ? { formatted: arrived.map(formatMessageBanner).join('\n\n') }
        : {})
    }
  }
  const arrived = readDelivery(typeFilter)
  return {
    ...(workerMailbox.runId ? { runId: workerMailbox.runId } : {}),
    dispatchId: workerMailbox.dispatchId,
    deliveryId: arrived?.delivery.id ?? null,
    messages: arrived?.messages ?? [],
    count: arrived?.messages.length ?? 0,
    replayed: arrived?.replayed ?? false,
    acknowledged: acknowledged?.delivery.id ?? null,
    ...(params.format || params.inject
      ? { formatted: arrived?.messages.map(formatMessageBanner).join('\n\n') ?? '' }
      : {})
  }
}
