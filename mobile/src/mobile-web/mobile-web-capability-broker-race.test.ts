import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebCapabilityBroker } from './mobile-web-capability-broker'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}
const WORKSPACE_ID = `workspace_0_${'01'.repeat(16)}`

describe('mobile web capability broker races', () => {
  it('prevents a cancelled terminal subscription from registering after host resolution', async () => {
    const harness = await createPrimedHarness()
    const tabs = deferredHostResult()
    harness.sendRequest.mockReturnValue(tabs.promise)

    const pending = harness.broker.handle(terminalSubscriptionRequest())
    await waitForTerminalResolution(harness)
    await harness.broker.handle(subscriptionCancel())
    tabs.resolve(terminalTabsResult())
    await pending

    expect(harness.subscribe).not.toHaveBeenCalled()
    expect(responseFor(harness.messages, 'T')).toEqual([])
  })

  it('prevents client replacement from reviving a pending terminal subscription', async () => {
    const harness = await createPrimedHarness()
    const tabs = deferredHostResult()
    harness.sendRequest.mockReturnValue(tabs.promise)

    const pending = harness.broker.handle(terminalSubscriptionRequest())
    await waitForTerminalResolution(harness)
    harness.broker.replaceClient(null)
    tabs.resolve(terminalTabsResult())
    await pending

    expect(harness.subscribe).not.toHaveBeenCalled()
    expect(responseFor(harness.messages, 'T')).toEqual([
      expect.objectContaining({
        status: 'error',
        error: { code: 'cancelled', retryable: false }
      })
    ])
  })

  it('prevents disposal from recreating host resources after terminal resolution', async () => {
    const harness = await createPrimedHarness()
    const tabs = deferredHostResult()
    harness.sendRequest.mockReturnValue(tabs.promise)

    const pending = harness.broker.handle(terminalSubscriptionRequest())
    await waitForTerminalResolution(harness)
    harness.broker.dispose()
    tabs.resolve(terminalTabsResult())
    await pending

    expect(harness.subscribe).not.toHaveBeenCalled()
    expect(responseFor(harness.messages, 'T')).toEqual([])
  })

  it('retains request replay protection across authenticated client replacement', async () => {
    const harness = await createPrimedHarness()

    harness.broker.replaceClient(null)
    await harness.broker.handle(workspaceSnapshotRequest())

    expect(harness.sendRequest).toHaveBeenCalledOnce()
    expect(responseFor(harness.messages, 'P').at(-1)).toMatchObject({
      status: 'error',
      error: { code: 'invalid_request', retryable: false }
    })
  })

  it('keeps a shell-owned native alert alive across Desktop client replacement', async () => {
    const alertResult = deferredAlertResult()
    const alert = vi.fn<NonNullable<MobileWebNativeCapabilityAuthority['alert']>>()
    alert.mockReturnValue(alertResult.promise)
    const harness = await createPrimedHarness(alert)

    const pending = harness.broker.handle(nativeAlertRequest())
    await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce())
    harness.broker.replaceClient(null)
    alertResult.resolve({ kind: 'button', buttonIndex: 1 })
    await pending

    expect(responseFor(harness.messages, 'A')).toEqual([
      expect.objectContaining({
        status: 'success',
        payload: { kind: 'button', buttonIndex: 1 }
      })
    ])
  })

  it('keeps an OS alert authoritative after page cancellation', async () => {
    const alertResult = deferredAlertResult()
    const alert = vi.fn<NonNullable<MobileWebNativeCapabilityAuthority['alert']>>()
    alert.mockReturnValue(alertResult.promise)
    const harness = await createPrimedHarness(alert)

    const pending = harness.broker.handle(nativeAlertRequest())
    await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce())
    await harness.broker.handle(requestCancel('A'))
    await harness.broker.handle(nativeAlertRequest('B'))

    expect(alert).toHaveBeenCalledOnce()
    expect(responseFor(harness.messages, 'B')).toEqual([
      expect.objectContaining({
        status: 'error',
        error: { code: 'rate_limited', retryable: true }
      })
    ])

    alertResult.resolve({ kind: 'button', buttonIndex: 0 })
    await pending
    expect(responseFor(harness.messages, 'A')).toEqual([
      expect.objectContaining({ status: 'success' })
    ])
  })
})

async function createPrimedHarness(alert?: MobileWebNativeCapabilityAuthority['alert']) {
  const messages: MobileWebBridgeShellMessage[] = []
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const subscribe = vi.fn<RpcClient['subscribe']>()
  const client = {
    sendRequest,
    subscribe,
    sendTerminalBinaryFrame: vi.fn(() => true)
  } as unknown as RpcClient
  const broker = new MobileWebCapabilityBroker({
    context: CONTEXT,
    getClient: () => client,
    isConnected: () => true,
    isActive: () => true,
    postMessage: (message) => messages.push(message),
    nativeAuthority: {
      alert,
      hapticFeedback: vi.fn(),
      clipboardWrite: vi.fn(),
      openExternal: vi.fn(),
      terminalPreferences: vi.fn(),
      terminalTextScaleUpdate: vi.fn()
    },
    navigationAuthority: {
      route: vi.fn(),
      reconnect: vi.fn(),
      removeHost: vi.fn(),
      consumeRecentUserGesture: () => true,
      hasRecentUserGesture: () => true
    },
    terminalClientId: 'device-token',
    randomBytes: (length) => new Uint8Array(length).fill(1)
  })
  sendRequest.mockResolvedValueOnce({
    ok: true,
    result: { worktrees: [{ worktreeId: 'workspace-1', repoId: 'repo-1' }] }
  })
  await broker.handle(workspaceSnapshotRequest())
  return { broker, messages, sendRequest, subscribe }
}

function nativeAlertRequest(id = 'A'): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return {
    ...envelope(),
    type: 'request',
    mode: 'once',
    requestId: id.repeat(22),
    capability: 'native',
    operation: 'alert',
    payload: {
      title: 'Discard changes?',
      message: 'Unsaved edits will be lost.',
      buttons: [
        { text: 'Stay', style: 'cancel' },
        { text: 'Discard', style: 'destructive' }
      ]
    }
  }
}

function requestCancel(id: string): Extract<MobileWebBridgePageMessage, { type: 'cancel' }> {
  return {
    ...envelope(),
    type: 'cancel',
    target: 'request',
    id: id.repeat(22)
  }
}

function workspaceSnapshotRequest(): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return {
    ...envelope(),
    type: 'request',
    mode: 'once',
    requestId: 'P'.repeat(22),
    capability: 'workspace',
    operation: 'snapshot',
    payload: { limit: 1 }
  }
}

function terminalSubscriptionRequest(): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return {
    ...envelope(),
    type: 'request',
    mode: 'subscription',
    requestId: 'T'.repeat(22),
    subscriptionId: 'Z'.repeat(22),
    capability: 'terminal',
    operation: 'subscribe',
    payload: {
      operation: 'subscribe',
      workspaceId: WORKSPACE_ID,
      tabId: 'terminal-1',
      viewport: { cols: 80, rows: 24 },
      visible: true
    }
  }
}

function subscriptionCancel(): Extract<MobileWebBridgePageMessage, { type: 'cancel' }> {
  return {
    ...envelope(),
    type: 'cancel',
    target: 'subscription',
    id: 'Z'.repeat(22)
  }
}

function envelope() {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId
  } as const
}

function deferredHostResult() {
  let resolve = (_value: ReturnType<typeof terminalTabsResult>): void => {}
  const promise = new Promise<ReturnType<typeof terminalTabsResult>>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function deferredAlertResult() {
  let resolve = (_value: { kind: 'button'; buttonIndex: number }): void => {}
  const promise = new Promise<{ kind: 'button'; buttonIndex: number }>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function terminalTabsResult() {
  return {
    ok: true as const,
    result: {
      worktree: 'workspace-1',
      activeTabId: 'terminal-1',
      tabs: [
        {
          id: 'terminal-1',
          type: 'terminal',
          status: 'ready',
          terminal: 'host-terminal-secret',
          isActive: true
        }
      ]
    }
  }
}

async function waitForTerminalResolution(
  harness: Awaited<ReturnType<typeof createPrimedHarness>>
): Promise<void> {
  await vi.waitFor(() =>
    expect(harness.sendRequest).toHaveBeenCalledWith('session.tabs.list', {
      worktree: 'id:workspace-1'
    })
  )
}

function responseFor(messages: MobileWebBridgeShellMessage[], id: string) {
  return messages.filter(
    (message) => message.type === 'response' && message.requestId === id.repeat(22)
  )
}
