import { describe, expect, it, vi } from 'vitest'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from './db/messages/mailbox-pointer-enter-state'
import { OrchestrationDb } from './db'
import { resumePendingOrchestrationMailboxPointer } from './mailbox-pointer-resume'
import { OrchestrationMailboxPointerState } from './mailbox-pointer-state'
import { submitOrchestrationMailboxPointer } from './mailbox-pointer-submit'

describe('orchestration mailbox pointer submit', () => {
  it('does not settle a replacement reservation after an old Enter write resolves', async () => {
    const db = new OrchestrationDb(':memory:')
    const message = db.insertMessage({ from: 'a', to: 'run:run-1', subject: 'staged' })
    const ptyId = 'pty-reused'
    const oldReservation = { ptyId, processIncarnation: 'inc-old' }
    const replacementReservation = { ptyId, processIncarnation: 'inc-new' }
    const leaf = {
      tabId: 'tab-1',
      leafId: 'leaf-1',
      ptyId,
      writable: true,
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true,
      lastOscTitle: 'Codex done'
    }
    const expectedTarget = {
      leaf,
      terminalHandle: 'term-reused',
      processIncarnation: oldReservation.processIncarnation
    }
    const state = new OrchestrationMailboxPointerState()
    const oldFlight = state.beginFlight(ptyId)
    state.setWatermark('run:run-1', 1, ptyId, 'tab-1:leaf-1')
    expect(db.stageMailboxPointerEnter([message.id], oldReservation)).toBe(true)
    expect(db.markMailboxPointerWriteAttempted([message.id], oldReservation)).toBe(true)
    let resolveWrite!: (accepted: boolean) => void
    const writePty = vi.fn(() => new Promise<boolean>((resolve) => (resolveWrite = resolve)))
    const settle = vi.fn()

    submitOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: () => 'run:run-1' } as never,
        state,
        getDb: () => db,
        resolveSubmitTarget: () => expectedTarget,
        getMessageWaiters: () => undefined,
        isLeafPtyProvenAbsent: async () => false,
        writePty,
        settle,
        redrive: vi.fn()
      },
      {
        leaf,
        mailboxHandle: 'run:run-1',
        messages: [{ id: message.id, type: 'status' }],
        newestSequence: 1,
        ptyId,
        flight: oldFlight,
        expectedTarget
      }
    )

    await vi.waitFor(() => expect(writePty).toHaveBeenCalledOnce())
    state.retirePty(ptyId)
    state.beginFlight(ptyId)
    db.releaseMailboxPointerEnter([message.id], oldReservation, [MAILBOX_POINTER_ENTER_ATTEMPTED])
    expect(db.stageMailboxPointerEnter([message.id], replacementReservation)).toBe(true)
    expect(db.markMailboxPointerWriteAttempted([message.id], replacementReservation)).toBe(true)
    resolveWrite(true)

    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
    expect(db.getMessageById(message.id)).toMatchObject({
      delivered_at: null,
      pointer_enter_pending: MAILBOX_POINTER_WRITE_ATTEMPTED,
      pointer_pty_id: ptyId,
      pointer_process_incarnation: replacementReservation.processIncarnation
    })
    db.close()
  })

  it('submits a staged pointer while its live PTY is cold parked', async () => {
    const ptyId = 'pty-parked'
    const mailboxHandle = 'run:run-1'
    const leaf = {
      tabId: 'tab-1',
      leafId: 'leaf-1',
      ptyId,
      writable: true,
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true,
      lastOscTitle: 'Codex done'
    }
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    state.setWatermark(mailboxHandle, 1, ptyId, 'tab-1:leaf-1')
    const writePty = vi.fn(async () => true)
    const markMailboxPointerEnterAttempted = vi.fn(() => true)
    const resolveMailbox = vi.fn(() => mailboxHandle)
    const settle = vi.fn(() => {
      state.settleFlight(ptyId, flight)
    })
    const target = {
      leaf,
      terminalHandle: 'term-parked',
      processIncarnation: 'inc-parked'
    }

    submitOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: resolveMailbox } as never,
        state,
        getDb: () =>
          ({
            areUnreadMessages: () => true,
            markMailboxPointerEnterAttempted,
            settleMailboxPointerEnter: vi.fn()
          }) as never,
        resolveSubmitTarget: () => target,
        getMessageWaiters: () => undefined,
        isLeafPtyProvenAbsent: async () => false,
        writePty,
        settle,
        redrive: vi.fn()
      },
      {
        leaf,
        mailboxHandle,
        messages: [{ id: 'msg-1', type: 'status' }],
        newestSequence: 1,
        ptyId,
        flight,
        expectedTarget: target
      }
    )

    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
    expect(writePty).toHaveBeenCalledOnce()
    expect(writePty).toHaveBeenCalledWith(ptyId, '\r')
    expect(resolveMailbox).toHaveBeenCalledWith(leaf, undefined, {
      terminalHandle: 'term-parked'
    })
    expect(markMailboxPointerEnterAttempted.mock.invocationCallOrder[0]).toBeLessThan(
      writePty.mock.invocationCallOrder[0]!
    )
  })

  it.each([
    ['working', { lastAgentStatus: 'working' as const }],
    ['permission', { lastAgentStatus: 'permission' as const }],
    ['stale', null]
  ])('does not submit after the parked target becomes %s', async (_name, targetOverride) => {
    const ptyId = 'pty-parked'
    const mailboxHandle = 'run:run-1'
    const leaf = {
      tabId: 'tab-1',
      leafId: 'leaf-1',
      ptyId,
      writable: true,
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true,
      lastOscTitle: 'Codex done'
    }
    const expectedTarget = {
      leaf,
      terminalHandle: 'term-parked',
      processIncarnation: 'inc-parked'
    }
    const currentTarget = targetOverride
      ? { ...expectedTarget, leaf: { ...leaf, ...targetOverride } }
      : null
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    state.setWatermark(mailboxHandle, 1, ptyId, 'tab-1:leaf-1')
    const releaseMailboxPointerEnter = vi.fn()
    const writePty = vi.fn(async () => true)
    const settle = vi.fn(() => state.settleFlight(ptyId, flight))
    const redrive = vi.fn()

    submitOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: () => mailboxHandle } as never,
        state,
        getDb: () => ({ areUnreadMessages: () => true, releaseMailboxPointerEnter }) as never,
        resolveSubmitTarget: () => currentTarget,
        getMessageWaiters: () => undefined,
        isLeafPtyProvenAbsent: async () => false,
        writePty,
        settle,
        redrive
      },
      {
        leaf,
        mailboxHandle,
        messages: [{ id: 'msg-1', type: 'status' }],
        newestSequence: 1,
        ptyId,
        flight,
        expectedTarget
      }
    )

    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
    expect(writePty).not.toHaveBeenCalled()
    expect(releaseMailboxPointerEnter).toHaveBeenCalledWith(
      ['msg-1'],
      { ptyId, processIncarnation: expectedTarget.processIncarnation },
      [MAILBOX_POINTER_WRITE_ATTEMPTED]
    )
    expect(redrive).toHaveBeenCalledWith(mailboxHandle, true)
  })

  it('does not submit after the parked PTY incarnation is replaced', async () => {
    const ptyId = 'pty-parked'
    const mailboxHandle = 'run:run-1'
    const leaf = {
      tabId: 'tab-1',
      leafId: 'leaf-1',
      ptyId,
      writable: true,
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true,
      lastOscTitle: 'Codex done'
    }
    const expectedTarget = {
      leaf,
      terminalHandle: 'term-parked',
      processIncarnation: 'inc-original'
    }
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    state.setWatermark(mailboxHandle, 1, ptyId, 'tab-1:leaf-1')
    const releaseMailboxPointerEnter = vi.fn()
    const writePty = vi.fn(async () => true)
    const settle = vi.fn(() => state.settleFlight(ptyId, flight))

    submitOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: () => mailboxHandle } as never,
        state,
        getDb: () => ({ areUnreadMessages: () => true, releaseMailboxPointerEnter }) as never,
        resolveSubmitTarget: () => ({ ...expectedTarget, processIncarnation: 'inc-replaced' }),
        getMessageWaiters: () => undefined,
        isLeafPtyProvenAbsent: async () => false,
        writePty,
        settle,
        redrive: vi.fn()
      },
      {
        leaf,
        mailboxHandle,
        messages: [{ id: 'msg-1', type: 'status' }],
        newestSequence: 1,
        ptyId,
        flight,
        expectedTarget
      }
    )

    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
    expect(writePty).not.toHaveBeenCalled()
    expect(releaseMailboxPointerEnter).toHaveBeenCalledWith(
      ['msg-1'],
      { ptyId, processIncarnation: expectedTarget.processIncarnation },
      [MAILBOX_POINTER_WRITE_ATTEMPTED]
    )
  })

  it('settles without redriving when teardown closes the database before rollback', async () => {
    const ptyId = 'pty-teardown'
    const mailboxHandle = 'run:run-teardown'
    const leaf = {
      tabId: 'tab-teardown',
      leafId: 'leaf-teardown',
      ptyId,
      writable: true,
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true,
      lastOscTitle: 'Codex done'
    }
    const expectedTarget = {
      leaf,
      terminalHandle: 'term-teardown',
      processIncarnation: 'inc-teardown'
    }
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight(ptyId)
    state.setWatermark(mailboxHandle, 1, ptyId, 'tab-teardown:leaf-teardown')
    const settle = vi.fn(() => state.settleFlight(ptyId, flight))
    const redrive = vi.fn()

    submitOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: () => mailboxHandle } as never,
        state,
        getDb: () =>
          ({
            areUnreadMessages: () => true,
            markAsUndelivered: () => {
              throw new Error('database is not open')
            }
          }) as never,
        resolveSubmitTarget: () => null,
        getMessageWaiters: () => undefined,
        isLeafPtyProvenAbsent: async () => false,
        writePty: vi.fn(async () => true),
        settle,
        redrive
      },
      {
        leaf,
        mailboxHandle,
        messages: [{ id: 'msg-teardown', type: 'status' }],
        newestSequence: 1,
        ptyId,
        flight,
        expectedTarget
      }
    )

    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce())
    expect(redrive).not.toHaveBeenCalled()
  })

  it.each([
    ['pointer acceptance', MAILBOX_POINTER_WRITE_ATTEMPTED],
    ['Enter acceptance', MAILBOX_POINTER_ENTER_ATTEMPTED]
  ])('fails closed after restart following %s before durable settlement', (_boundary, phase) => {
    const ptyId = 'pty-surviving'
    const mailboxHandle = 'run:run-surviving'
    const leaf = {
      tabId: 'tab-surviving',
      leafId: 'leaf-surviving',
      ptyId,
      writable: true,
      lastAgentStatus: 'idle' as const,
      lastAgentStatusObservedLive: true,
      lastOscTitle: 'Codex done'
    }
    const target = {
      leaf,
      terminalHandle: 'term-surviving',
      processIncarnation: 'inc-surviving'
    }
    const settleMailboxPointerEnter = vi.fn()
    const releaseMailboxPointerEnter = vi.fn()
    const writePty = vi.fn(async () => true)

    const resumed = resumePendingOrchestrationMailboxPointer({
      deps: {
        getDb: () => ({ settleMailboxPointerEnter, releaseMailboxPointerEnter }) as never,
        resolveSubmitTarget: () => target,
        writePty
      } as never,
      state: new OrchestrationMailboxPointerState(),
      leaf,
      mailboxHandle,
      messages: [
        {
          id: 'msg-surviving',
          type: 'status',
          sequence: 1,
          pointer_enter_pending: phase,
          pointer_pty_id: ptyId,
          pointer_process_incarnation: target.processIncarnation
        }
      ],
      enterDelayMs: 0,
      leafKey: 'tab-surviving:leaf-surviving',
      settle: vi.fn(),
      redrive: vi.fn()
    })

    expect(resumed).toBe(true)
    expect(settleMailboxPointerEnter).toHaveBeenCalledWith(
      ['msg-surviving'],
      { ptyId, processIncarnation: target.processIncarnation },
      [MAILBOX_POINTER_WRITE_ATTEMPTED, MAILBOX_POINTER_ENTER_ATTEMPTED]
    )
    expect(releaseMailboxPointerEnter).not.toHaveBeenCalled()
    expect(writePty).not.toHaveBeenCalled()
  })
})
