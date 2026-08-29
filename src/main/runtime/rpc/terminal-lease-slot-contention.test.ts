import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

// Why this file exists: the host keeps ONE input-lease slot per (terminal, client), and
// re-registering it evicts the incumbent on purpose — that is what makes a mobile
// reconnect rebind instead of leaking a duplicate data listener (STA-4510). The slot is
// therefore not the defect; a second mounted session screen for the same worktree,
// subscribing under the same client id, is. This pins what such a duplicate costs.

const runtimeDouble = (registry: ReturnType<typeof createSubscriptionRegistryDouble>) =>
  ({
    getRuntimeId: () => 'test-runtime',
    registerRemoteTerminalViewSubscriber: () => () => {},
    requestRendererTerminalTabMount: () => false,
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    subscribeToTerminalData: vi.fn(() => vi.fn()),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    cleanupSubscriptionIfOwnedByConnection: vi.fn(registry.cleanupSubscriptionIfOwnedByConnection),
    subscribeToPtyExit: vi.fn(() => vi.fn())
  }) as unknown as OrcaRuntimeService

const leaseRequest: RpcRequest = {
  id: 'req-1',
  authToken: 'tok',
  method: 'terminal.subscribe',
  params: {
    terminal: 'terminal-1',
    client: { id: 'phone-1', type: 'mobile' },
    capabilities: { terminalBinaryStream: 1, mobileInputLeaseOnly: 1 }
  }
}

const frameType = (message: string): string =>
  String((JSON.parse(message) as { result?: { type?: unknown } }).result?.type)

const streamOptions = (connectionId: string) => ({
  connectionId,
  sendBinary: vi.fn(),
  registerBinaryStreamHandler: vi.fn(() => vi.fn())
})

describe('terminal input-lease slot contention', () => {
  it('ends the incumbent lease when a second screen subscribes under the same client id', async () => {
    const registry = createSubscriptionRegistryDouble()
    const runtime = runtimeDouble(registry)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const firstScreen: string[] = []
    void dispatcher.dispatchStreaming(
      leaseRequest,
      (message) => firstScreen.push(frameType(message)),
      streamOptions('screen-a')
    )
    await vi.waitFor(() => expect(firstScreen).toEqual(['subscribed']))

    // The duplicate mount: a second live session screen for the same worktree, on the
    // same device token, subscribing to the same terminal handle.
    const secondScreen: string[] = []
    void dispatcher.dispatchStreaming(
      leaseRequest,
      (message) => secondScreen.push(frameType(message)),
      streamOptions('screen-b')
    )
    await vi.waitFor(() => expect(secondScreen).toEqual(['subscribed']))

    // `end` is exactly the frame the mobile session screen turns into
    // clearNativeChatInputLease(handle) — its composer stays editable and Send goes
    // dead. Whichever screen resubscribes last owns the lease, so two screens
    // ping-pong it on every session-tabs snapshot.
    await vi.waitFor(() => expect(firstScreen).toEqual(['subscribed', 'end']))
  })
})
