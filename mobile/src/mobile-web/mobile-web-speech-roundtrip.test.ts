import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebCapabilityBroker } from './mobile-web-capability-broker'

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}

describe('mobile web speech broker', () => {
  it('serves bounded setup metadata through an authenticated once request', async () => {
    const harness = createHarness()
    harness.sendRequest.mockResolvedValue({
      id: 'rpc',
      ok: true,
      result: setup(),
      _meta: { runtimeId: 'runtime' }
    })

    await harness.broker.handle(request('A', 'once', 'setup', {}))

    expect(harness.messages.at(-1)).toMatchObject({
      type: 'response',
      status: 'success',
      payload: setup()
    })
  })

  it('accounts for the single speech subscription and releases it on cancel', async () => {
    const harness = createHarness()
    await harness.broker.handle(request('A', 'subscription', 'subscribe', {}, 'Q'))
    await harness.broker.handle(request('B', 'subscription', 'subscribe', {}, 'R'))
    expect(harness.messages.at(-1)).toMatchObject({
      status: 'error',
      error: { code: 'rate_limited' }
    })

    await harness.broker.handle(cancel('Q'))
    await harness.broker.handle(request('C', 'subscription', 'subscribe', {}, 'T'))

    expect(harness.messages.at(-1)).toMatchObject({
      status: 'success',
      payload: null
    })
  })

  it('rejects speech configuration without a recent native-observed gesture', async () => {
    const harness = createHarness()

    await harness.broker.handle(
      request('A', 'once', 'configure', {
        dictationMode: 'hold'
      })
    )

    expect(harness.messages.at(-1)).toMatchObject({
      status: 'error',
      error: { code: 'permission_required' }
    })
    expect(harness.sendRequest).not.toHaveBeenCalled()
  })
})

function createHarness() {
  const messages: MobileWebBridgeShellMessage[] = []
  const sendRequest = vi.fn<RpcClient['sendRequest']>()
  const client = { sendRequest } as unknown as RpcClient
  const broker = new MobileWebCapabilityBroker({
    context: CONTEXT,
    getClient: () => client,
    isConnected: () => true,
    isActive: () => true,
    postMessage: (message) => {
      messages.push(message)
    },
    nativeAuthority: {
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
      consumeRecentUserGesture: vi.fn(() => false),
      hasRecentUserGesture: () => true
    },
    terminalClientId: 'device-token',
    randomBytes: (length) => new Uint8Array(length).fill(1),
    now: () => 1000
  })
  return { broker, messages, sendRequest }
}

function request(
  id: string,
  mode: 'once' | 'subscription',
  operation: string,
  payload: unknown,
  subscriptionId = ''
): Extract<MobileWebBridgePageMessage, { type: 'request' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'request',
    mode,
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    requestId: id.repeat(22),
    ...(mode === 'subscription' ? { subscriptionId: subscriptionId.repeat(22) } : {}),
    capability: 'speech',
    operation,
    payload
  } as Extract<MobileWebBridgePageMessage, { type: 'request' }>
}

function cancel(id: string): Extract<MobileWebBridgePageMessage, { type: 'cancel' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'cancel',
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    target: 'subscription',
    id: id.repeat(22)
  }
}

function setup() {
  return {
    enabled: true,
    selectedModelId: 'model-1',
    dictationMode: 'toggle',
    models: [
      {
        id: 'model-1',
        label: 'Model One',
        provider: 'local',
        sizeBytes: 1024,
        recommended: true,
        status: 'ready',
        progress: null
      }
    ]
  }
}
