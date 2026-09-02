import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { createClaudeAgentSdkControlBridge } from './claude-agent-sdk-control-bridge'
import type { ClaudeControlRequest } from './claude-stream-json-connection'

type CanUseToolOptions = Parameters<CanUseTool>[2]

function permissionOptions(requestId: string, signal: AbortSignal): CanUseToolOptions {
  return { requestId, toolUseID: 'toolu_1', signal } as unknown as CanUseToolOptions
}

/** A pending permission callback is indistinguishable from a slow one, so bound it. */
function within<T>(promise: Promise<T>, ms = 200): Promise<T | 'pending'> {
  return Promise.race([
    promise,
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))
  ])
}

describe('claude agent SDK control bridge', () => {
  it('answers a permission callback whose signal already aborted', async () => {
    const delivered: ClaudeControlRequest[] = []
    const cancelled: string[] = []
    const bridge = createClaudeAgentSdkControlBridge({
      onControlRequest: (request) => delivered.push(request),
      onControlCancelRequest: (request) => cancelled.push(request.request_id)
    })
    const controller = new AbortController()
    // The cancel raced ahead of delivery: no abort event will ever fire, so
    // registering a listener first would park the callback forever.
    controller.abort()

    const answer = bridge.canUseTool(
      'Bash',
      { command: 'ls' },
      permissionOptions('perm-1', controller.signal)
    )

    await expect(within(answer)).resolves.toBeNull()
    expect(delivered).toEqual([])
    expect(cancelled).toEqual(['perm-1'])
  })

  it('still registers a live permission request and cancels it when the abort lands', async () => {
    const delivered: ClaudeControlRequest[] = []
    const cancelled: string[] = []
    const bridge = createClaudeAgentSdkControlBridge({
      onControlRequest: (request) => delivered.push(request),
      onControlCancelRequest: (request) => cancelled.push(request.request_id)
    })
    const controller = new AbortController()

    const answer = bridge.canUseTool(
      'Bash',
      { command: 'ls' },
      permissionOptions('perm-2', controller.signal)
    )
    expect(delivered.map((request) => request.request_id)).toEqual(['perm-2'])
    await expect(within(answer, 50)).resolves.toBe('pending')

    controller.abort()

    await expect(within(answer)).resolves.toBeNull()
    expect(cancelled).toEqual(['perm-2'])
  })
})
