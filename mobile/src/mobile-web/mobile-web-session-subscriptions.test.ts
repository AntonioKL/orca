import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH } from '../../../src/shared/agent-status-types'
import { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { mobileWebHostWorkspaceIdFromHost } from './mobile-web-workspace-authority'
import { MobileWebSessionSubscriptions } from './mobile-web-session-subscriptions'

const HOST_WORKSPACE_ID = mobileWebHostWorkspaceIdFromHost('repo-1::/workspaces/one')

function hostSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worktree: HOST_WORKSPACE_ID,
    publicationEpoch: 'renderer:1',
    snapshotVersion: 1,
    activeTabId: null,
    activeTabType: null,
    tabs: [],
    ...overrides
  }
}

function harness(postEventImplementation?: () => Promise<void>) {
  const postEvent = vi.fn(postEventImplementation ?? (() => Promise.resolve()))
  const postError = vi.fn(() => Promise.resolve())
  const subscriptions = new MobileWebSessionSubscriptions({
    isActive: () => true,
    postEvent,
    postError,
    browserAuthority: new MobileWebBrowserAuthority((length) => new Uint8Array(length)),
    nativeChatAuthority: new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
  })
  let emit: (value: unknown) => void = () => {}
  const unsubscribe = vi.fn()
  const client = {
    subscribe: vi.fn((_method: string, _params: unknown, onEvent: (value: unknown) => void) => {
      emit = onEvent
      return unsubscribe
    })
  } as unknown as RpcClient
  subscriptions.start({
    requestId: 'request-1',
    subscriptionId: 'subscription-1',
    pageWorkspaceId: 'workspace_0_page',
    hostWorkspaceId: HOST_WORKSPACE_ID,
    client
  })
  return { subscriptions, postEvent, postError, unsubscribe, emit: (value: unknown) => emit(value) }
}

describe('mobile web session subscriptions', () => {
  it('reports a rejected host snapshot to the page instead of cancelling silently', () => {
    const { postEvent, postError, unsubscribe, emit } = harness()

    emit(hostSnapshot({ worktree: 'repo-2::/workspaces/other' }))

    expect(postEvent).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(postError).toHaveBeenCalledWith('request-1', 'host_error', true)
  })

  it('reports an oversized snapshot to the page instead of cancelling silently', () => {
    const { postEvent, postError, emit } = harness()

    emit(
      hostSnapshot({
        tabs: Array.from({ length: 40 }, (_value, index) => ({
          type: 'terminal',
          id: `tab-${index}`,
          title: 'x'.repeat(240),
          status: 'ready',
          agentStatus: {
            state: 'working',
            lastAssistantMessage: 'y'.repeat(AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH)
          }
        }))
      })
    )

    expect(postEvent).not.toHaveBeenCalled()
    expect(postError).toHaveBeenCalledWith('request-1', 'too_large', false)
  })

  it('reports a failed event delivery to the page instead of cancelling silently', async () => {
    const { postError, emit } = harness(() => Promise.reject(new Error('post failed')))

    emit(hostSnapshot())
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(postError).toHaveBeenCalledWith('request-1', 'unavailable', true)
  })

  it('stays silent when the page or the broker retires the subscription', () => {
    const { subscriptions, postError } = harness()

    subscriptions.cancel('subscription-1')
    subscriptions.dispose()

    expect(postError).not.toHaveBeenCalled()
  })
})
