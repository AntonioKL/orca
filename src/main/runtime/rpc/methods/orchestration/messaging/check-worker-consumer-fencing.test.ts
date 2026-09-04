import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const PANE_A = 'tab_a:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PANE_B = 'tab_b:dddddddd-dddd-4ddd-8ddd-dddddddddddd'

type CheckResult = {
  deliveryId: string | null
  messages: { subject: string }[]
  count: number
  replayed: boolean
}

/** Two processes served one Dispatch mailbox until v36 gave it a consumer generation. */
describe('orchestration.check on a re-attached Dispatch', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
  })

  function attachedDispatchWithMail(): string {
    ;({ db, ctx } = h.setup())
    const task = db.createTask({ spec: 'worker that gets replaced' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', PANE_A)
    db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: PANE_A,
      processIncarnation: 'runtime:pty-a:1'
    })
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'do the work',
      runId: dispatch.run_id
    })
    return dispatch.id
  }

  function check(paneKey: string, params: Record<string, unknown> = {}) {
    return h.call(
      'orchestration.check',
      { terminal: 'term_worker', terminalPaneKey: paneKey, ...params },
      ctx
    ) as Promise<CheckResult>
  }

  function reattach(dispatchId: string): void {
    db.mintDispatchCapability({
      dispatchId,
      paneKey: PANE_B,
      processIncarnation: 'runtime:pty-b:1'
    })
  }

  it('refuses the stale worker its ack and names the re-attach', async () => {
    const dispatchId = attachedDispatchWithMail()
    const staleDelivery = (await check(PANE_A)).deliveryId
    expect(staleDelivery).not.toBeNull()
    reattach(dispatchId)

    await expect(check(PANE_A, { ack: staleDelivery })).rejects.toMatchObject({
      code: 'consumer_fenced',
      message: expect.stringContaining('re-attached to another worker')
    })
    expect(db.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(1)
  })

  it('hands the live worker a fresh Delivery with the same unread mail', async () => {
    const dispatchId = attachedDispatchWithMail()
    const staleDelivery = (await check(PANE_A)).deliveryId
    reattach(dispatchId)

    const live = await check(PANE_B)
    expect(live.deliveryId).not.toBe(staleDelivery)
    expect(live.replayed).toBe(false)
    expect(live.messages.map((message) => message.subject)).toEqual(['do the work'])

    await check(PANE_B, { ack: live.deliveryId })
    expect(db.getUnreadMessages(`dispatch:${dispatchId}`)).toEqual([])
  })

  it('keeps serving a worker whose process restarted without a re-attach', async () => {
    attachedDispatchWithMail()
    const first = await check(PANE_A)

    const replay = await check(PANE_A)
    expect(replay.deliveryId).toBe(first.deliveryId)
    expect(replay.replayed).toBe(true)
    await expect(check(PANE_A, { ack: first.deliveryId })).resolves.toMatchObject({
      acknowledged: first.deliveryId
    })
  })
})
