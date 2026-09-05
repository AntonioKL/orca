import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryOrchestrationMessages, deferred } from '../orca-runtime-test-fixtures.spec'
import type { OrchestrationDb } from './db'
import type { OrchestrationMailboxDeliveryTarget } from './mailbox-delivery-target'
import type { OrchestrationMailboxLeaf, OrchestrationMailboxOwner } from './mailbox-owner'
import { OrchestrationMailboxPointerDelivery } from './mailbox-pointer-delivery'
import type { SubmitStatuslessCodexPointer } from './mailbox-statusless-codex-submit'

const MAILBOX = 'run:run-1'
const TERMINAL_HANDLE = 'term-1'

function statuslessLeaf(): OrchestrationMailboxLeaf {
  return {
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    writable: true,
    lastAgentStatus: null,
    lastAgentStatusObservedLive: false,
    lastOscTitle: null
  }
}

function makeHarness(
  proveStatuslessCodexIdle: (terminalHandle: string, ptyId: string) => Promise<string | null>,
  options: {
    withMessage?: boolean
    submitStatuslessCodexPointer?: SubmitStatuslessCodexPointer
  } = {}
) {
  let leaf = statuslessLeaf()
  let processIncarnation = 'pty-1:incarnation-1'
  const db = new InMemoryOrchestrationMessages()
  if (options.withMessage !== false) {
    db.insertMessage({ from: 'term-sender', to: MAILBOX, subject: 'wake work' })
  }
  const writePty = vi.fn().mockReturnValue(true)
  const delivery = new OrchestrationMailboxPointerDelivery({
    mailboxOwner: { resolve: () => MAILBOX } as unknown as OrchestrationMailboxOwner,
    deliveryTarget: {
      resolveTerminalHandle: () => TERMINAL_HANDLE,
      deferForAbsenceProbe: () => false
    } as unknown as OrchestrationMailboxDeliveryTarget,
    getDb: () => db as unknown as OrchestrationDb,
    getLeaf: () => leaf,
    getLeafKey: (tabId, leafId) => `${tabId}:${leafId}`,
    getLiveLeafForHandle: () => leaf,
    getMessageWaiters: () => undefined,
    getTabTitle: () => null,
    getTerminalHandleForLeafKey: () => TERMINAL_HANDLE,
    getTerminalProcessIncarnation: () => processIncarnation,
    isLeafPtyProvenAbsent: () => Promise.resolve(false),
    proveStatuslessCodexIdle,
    redriveMailbox: () => undefined,
    ...(options.submitStatuslessCodexPointer
      ? { submitStatuslessCodexPointer: options.submitStatuslessCodexPointer }
      : {}),
    writePty
  })
  return {
    db,
    delivery,
    getLeaf: () => leaf,
    setLeaf: (next: OrchestrationMailboxLeaf) => {
      leaf = next
    },
    setProcessIncarnation: (next: string) => {
      processIncarnation = next
    },
    writePty
  }
}

describe('statusless Codex mailbox pointer delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('submits after the current Codex process is proven idle', async () => {
    const proveStatuslessCodexIdle = vi.fn().mockResolvedValue('pty-1:incarnation-1')
    const { db, delivery, writePty } = makeHarness(proveStatuslessCodexIdle)

    delivery.deliverForHandle(MAILBOX)
    await vi.waitFor(() => expect(writePty).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(500)

    expect(proveStatuslessCodexIdle).toHaveBeenCalledWith(TERMINAL_HANDLE, 'pty-1')
    expect(writePty.mock.calls[0]?.[1]).toContain('You have 1 orchestration message')
    expect(writePty).toHaveBeenCalledWith('pty-1', '\r')
    expect(db.getUnreadMessages(MAILBOX)[0]?.delivered_at).toEqual(expect.any(String))
  })

  it.each(['working', 'permission'] as const)(
    'does not prove or inject while a live %s status is authoritative',
    async (status) => {
      const proveStatuslessCodexIdle = vi.fn().mockResolvedValue('pty-1:incarnation-1')
      const harness = makeHarness(proveStatuslessCodexIdle)
      harness.setLeaf({
        ...harness.getLeaf(),
        lastAgentStatus: status,
        lastAgentStatusObservedLive: true
      })

      harness.delivery.deliverForHandle(MAILBOX)
      await Promise.resolve()

      expect(proveStatuslessCodexIdle).not.toHaveBeenCalled()
      expect(harness.writePty).not.toHaveBeenCalled()
    }
  )

  it('does not start an idle proof when the mailbox has no pointer candidate', () => {
    const proveStatuslessCodexIdle = vi.fn().mockResolvedValue('pty-1:incarnation-1')
    const harness = makeHarness(proveStatuslessCodexIdle, { withMessage: false })

    harness.delivery.deliverForHandle(MAILBOX)

    expect(proveStatuslessCodexIdle).not.toHaveBeenCalled()
  })

  it('rejects a proof when the pane is rebound to another PTY', async () => {
    const proof = deferred<string | null>()
    const harness = makeHarness(() => proof.promise)

    harness.delivery.deliverForHandle(MAILBOX)
    harness.setLeaf({ ...harness.getLeaf(), ptyId: 'pty-2' })
    proof.resolve('pty-1:incarnation-1')
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.writePty).not.toHaveBeenCalled()
  })

  it('rejects a proof when the PTY process incarnation is replaced', async () => {
    const proof = deferred<string | null>()
    const harness = makeHarness(() => proof.promise)

    harness.delivery.deliverForHandle(MAILBOX)
    harness.setProcessIncarnation('pty-1:incarnation-2')
    proof.resolve('pty-1:incarnation-1')
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.writePty).not.toHaveBeenCalled()
  })

  it.each(['working', 'permission'] as const)(
    'does not submit when live %s status contradicts the completed proof',
    async (status) => {
      const harness = makeHarness(() => Promise.resolve('pty-1:incarnation-1'))

      harness.delivery.deliverForHandle(MAILBOX)
      await vi.waitFor(() => expect(harness.writePty).toHaveBeenCalledTimes(1))
      harness.setLeaf({
        ...harness.getLeaf(),
        lastAgentStatus: status,
        lastAgentStatusObservedLive: true
      })
      await vi.advanceTimersByTimeAsync(500)

      expect(harness.writePty).not.toHaveBeenCalledWith('pty-1', '\r')
    }
  )

  it.each(['working', 'permission'] as const)(
    'guards structured submission from a live %s transition',
    async (status) => {
      const startWrite = deferred<void>()
      const finished = deferred<void>()
      const wrote = vi.fn()
      const submitStatuslessCodexPointer = vi.fn(
        async (_handle: string, ptyId: string, _prompt: string, beforeWrite) => {
          try {
            await startWrite.promise
            await beforeWrite(ptyId)
            wrote()
          } finally {
            finished.resolve()
          }
        }
      )
      const harness = makeHarness(() => Promise.resolve('pty-1:incarnation-1'), {
        submitStatuslessCodexPointer
      })

      harness.delivery.deliverForHandle(MAILBOX)
      await vi.waitFor(() => expect(submitStatuslessCodexPointer).toHaveBeenCalledTimes(1))
      harness.setLeaf({
        ...harness.getLeaf(),
        lastAgentStatus: status,
        lastAgentStatusObservedLive: true
      })
      startWrite.resolve()
      await finished.promise
      await Promise.resolve()

      expect(wrote).not.toHaveBeenCalled()
      expect(harness.db.getUnreadMessages(MAILBOX)[0]?.delivered_at).toBeNull()
      expect(harness.writePty).not.toHaveBeenCalled()
    }
  )

  it('keeps mail undelivered when structured submission observes no turn effect', async () => {
    const finished = deferred<void>()
    const submitStatuslessCodexPointer = vi.fn(
      async (_handle: string, ptyId: string, _prompt: string, beforeWrite) => {
        try {
          await beforeWrite(ptyId)
          await beforeWrite(ptyId)
          throw new Error('agent_prompt_stalled')
        } finally {
          finished.resolve()
        }
      }
    )
    const harness = makeHarness(() => Promise.resolve('pty-1:incarnation-1'), {
      submitStatuslessCodexPointer
    })

    harness.delivery.deliverForHandle(MAILBOX)
    await finished.promise
    await Promise.resolve()

    expect(submitStatuslessCodexPointer).toHaveBeenCalledTimes(1)
    expect(harness.db.getUnreadMessages(MAILBOX)[0]?.delivered_at).toBeNull()
    expect(harness.writePty).not.toHaveBeenCalled()
  })

  it('requeues staged mail when the process is replaced before submit', async () => {
    const harness = makeHarness(() => Promise.resolve('pty-1:incarnation-1'))

    harness.delivery.deliverForHandle(MAILBOX)
    await vi.waitFor(() => expect(harness.writePty).toHaveBeenCalledTimes(1))
    harness.setProcessIncarnation('pty-1:incarnation-2')
    await vi.advanceTimersByTimeAsync(500)

    expect(harness.writePty).not.toHaveBeenCalledWith('pty-1', '\r')
    expect(harness.db.getUnreadMessages(MAILBOX)[0]?.delivered_at).toBeNull()
  })

  it('deduplicates concurrent idle proofs for the same PTY', async () => {
    const proof = deferred<string | null>()
    const proveStatuslessCodexIdle = vi.fn(() => proof.promise)
    const harness = makeHarness(proveStatuslessCodexIdle)

    harness.delivery.deliverForHandle(MAILBOX)
    harness.delivery.deliverForHandle(MAILBOX)

    expect(proveStatuslessCodexIdle).toHaveBeenCalledTimes(1)
    proof.resolve('pty-1:incarnation-1')
    await vi.waitFor(() => expect(harness.writePty).toHaveBeenCalledTimes(1))
  })

  it('does not let a retired proof block a recycled PTY incarnation', async () => {
    const retiredProof = deferred<string | null>()
    const proveStatuslessCodexIdle = vi
      .fn()
      .mockImplementationOnce(() => retiredProof.promise)
      .mockResolvedValueOnce('pty-1:incarnation-2')
    const harness = makeHarness(proveStatuslessCodexIdle)

    harness.delivery.deliverForHandle(MAILBOX)
    harness.delivery.retirePty('pty-1')
    harness.setProcessIncarnation('pty-1:incarnation-2')
    harness.delivery.deliverForHandle(MAILBOX)

    await vi.waitFor(() => expect(harness.writePty).toHaveBeenCalledTimes(1))
    expect(proveStatuslessCodexIdle).toHaveBeenCalledTimes(2)
    retiredProof.resolve('pty-1:incarnation-1')
    await Promise.resolve()
    expect(harness.writePty).toHaveBeenCalledTimes(1)
  })
})
