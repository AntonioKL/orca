import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { useNewWorktreeRuntimeCapabilities } from './worktree-create-capability'
import { createWorktreeWithNameRetry } from './worktree-create-retry'

type CapabilityHook = ReturnType<typeof useNewWorktreeRuntimeCapabilities>

class CapabilityClient implements RpcClient {
  private readonly listeners = new Set<(state: ConnectionState) => void>()
  private state: ConnectionState = 'connected'
  readonly statusRequests = vi.fn<() => Promise<RpcResponse>>()
  readonly createRequests: Record<string, unknown>[] = []

  constructor(statusOutcomes: Array<RpcResponse | Error>) {
    let statusCall = 0
    this.statusRequests.mockImplementation(async () => {
      const outcome = statusOutcomes[Math.min(statusCall, statusOutcomes.length - 1)]!
      statusCall += 1
      if (outcome instanceof Error) {
        throw outcome
      }
      return outcome
    })
  }

  async sendRequest(method: string, params?: unknown): Promise<RpcResponse> {
    if (method === 'status.get') {
      return this.statusRequests()
    }
    this.createRequests.push((params ?? {}) as Record<string, unknown>)
    return success({ worktree: { id: 'wt-1' } })
  }

  subscribe(): () => void {
    return () => {}
  }

  updateTerminalSubscriptionViewport(): void {}
  getState(): ConnectionState {
    return this.state
  }
  getReconnectAttempt(): number {
    return 0
  }
  getLastConnectedAt(): number | null {
    return null
  }
  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  notifyForeground(): void {}
  close(): void {}

  emitState(state: ConnectionState): void {
    this.state = state
    for (const listener of this.listeners) {
      listener(state)
    }
  }
}

function success(result: unknown): RpcResponse {
  return { id: '1', ok: true, result, _meta: { runtimeId: 'r' } }
}

function unsupported(): RpcResponse {
  return {
    id: '1',
    ok: false,
    error: { code: 'unsupported', message: 'unsupported' },
    _meta: { runtimeId: 'r' }
  }
}

function supported(): RpcResponse {
  return success({
    capabilities: ['mobile.tasks.v1', 'worktree.create-idempotency.v1'],
    hostPlatform: 'darwin'
  })
}

async function mountCapabilities(client: RpcClient): Promise<{
  readonly current: CapabilityHook
  unmount(): void
}> {
  let current: CapabilityHook | null = null
  let renderer: ReactTestRenderer | null = null
  function Probe(): null {
    current = useNewWorktreeRuntimeCapabilities(client, true)
    return null
  }
  await act(async () => {
    renderer = create(createElement(Probe))
    await Promise.resolve()
  })
  return {
    get current(): CapabilityHook {
      if (!current) {
        throw new Error('capability probe did not render')
      }
      return current
    },
    unmount: () => act(() => renderer?.unmount())
  }
}

describe('useNewWorktreeRuntimeCapabilities reconnect recovery', () => {
  it('recovers a transient probe and enables idempotent create after reconnect', async () => {
    const client = new CapabilityClient([new Error('offline'), supported()])
    const capabilities = await mountCapabilities(client)

    await act(async () => {
      client.emitState('reconnecting')
      client.emitState('connected')
      await Promise.resolve()
    })
    await createWorktreeWithNameRetry({
      client,
      baseName: 'otter',
      buildParams: (name) => ({ repo: 'id:r', name }),
      supportsIdempotentCutoverRetry: capabilities.current.getWorktreeCreateCutoverSupport(),
      mintMutationId: () => 'mutation-after-reconnect'
    })

    expect({
      statusRequests: client.statusRequests.mock.calls.length,
      tasksSupported: capabilities.current.tasksSupported,
      clientMutationId: client.createRequests[0]?.clientMutationId
    }).toEqual({
      statusRequests: 2,
      tasksSupported: true,
      clientMutationId: 'mutation-after-reconnect'
    })
    capabilities.unmount()
  })

  it('keeps an authoritative unsupported response cached across reconnect', async () => {
    const client = new CapabilityClient([unsupported(), supported()])
    const capabilities = await mountCapabilities(client)

    await act(async () => {
      client.emitState('reconnecting')
      client.emitState('connected')
      await Promise.resolve()
    })

    expect(client.statusRequests).toHaveBeenCalledOnce()
    expect(capabilities.current.tasksSupported).toBe(false)
    capabilities.unmount()
  })

  it('starts at most one replacement probe for a flapping reconnect', async () => {
    const client = new CapabilityClient([new Error('offline'), supported()])
    const capabilities = await mountCapabilities(client)

    await act(async () => {
      client.emitState('reconnecting')
      client.emitState('disconnected')
      client.emitState('reconnecting')
      client.emitState('connected')
      client.emitState('connected')
      await Promise.all([
        capabilities.current.getWorktreeCreateCutoverSupport(),
        capabilities.current.getWorktreeCreateCutoverSupport()
      ])
    })

    expect(client.statusRequests).toHaveBeenCalledTimes(2)
    expect(capabilities.current.tasksSupported).toBe(true)
    capabilities.unmount()
  })
})
