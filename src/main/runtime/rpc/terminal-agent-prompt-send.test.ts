import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { TerminalSend } from './methods/terminal/unary-schemas'

function makeRequest(params: unknown): RpcRequest {
  return { id: 'request', authToken: 'token', method: 'terminal.send', params }
}

function makeRuntime(overrides: Partial<OrcaRuntimeService>): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    ...overrides
  } as OrcaRuntimeService
}

describe('terminal agent prompt send RPC', () => {
  it('leaves a safe raw payload when an older host strips Quick Command intent', () => {
    const LegacyTerminalSend = TerminalSend.omit({ quickCommand: true })

    expect(
      LegacyTerminalSend.parse({
        terminal: 'terminal-1',
        text: 'echo x\r',
        quickCommand: true,
        client: { id: 'orca-desktop', type: 'desktop' }
      })
    ).toEqual({
      terminal: 'terminal-1',
      text: 'echo x\r',
      client: { id: 'orca-desktop', type: 'desktop' }
    })
  })

  it('routes a submitted Quick Command through settled prompt delivery', async () => {
    const sendTerminal = vi.fn()
    const sendTerminalAgentPrompt = vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      accepted: true,
      bytesWritten: 19
    })
    const runtime = makeRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      isTerminalRunningSettledPromptAgent: vi.fn().mockResolvedValue(true),
      sendTerminal,
      sendTerminalAgentPrompt
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        terminal: 'terminal-1',
        text: 'review this change\r',
        quickCommand: true,
        client: { id: 'orca-desktop', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.isTerminalRunningSettledPromptAgent).toHaveBeenCalledWith('terminal-1')
    expect(sendTerminalAgentPrompt).toHaveBeenCalledWith('terminal-1', 'review this change', {
      beforeWrite: expect.any(Function),
      signal: undefined
    })
    const beforeWrite = sendTerminalAgentPrompt.mock.calls[0][2].beforeWrite as (
      ptyId: string
    ) => Promise<void>
    runtime.getDriver = vi.fn().mockReturnValue({ kind: 'mobile', clientId: 'mobile-1' })
    await expect(beforeWrite('pty-1')).rejects.toThrow('terminal_guard_not_writable')
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('preserves the exact raw Quick Command bytes for shells and other terminal apps', async () => {
    const sendTerminal = vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      accepted: true,
      bytesWritten: 7
    })
    const sendTerminalAgentPrompt = vi.fn()
    const runtime = makeRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      isTerminalRunningSettledPromptAgent: vi.fn().mockResolvedValue(false),
      sendTerminal,
      sendTerminalAgentPrompt
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        terminal: 'terminal-1',
        text: 'echo x\r',
        quickCommand: true,
        client: { id: 'orca-desktop', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    expect(sendTerminal).toHaveBeenCalledWith(
      'terminal-1',
      { text: 'echo x\r', enter: false, interrupt: false },
      { beforeWrite: expect.any(Function) }
    )
    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it.each([
    ['missing CR', { text: 'echo x' }],
    ['empty command', { text: '\r' }],
    ['separate Enter', { text: 'echo x\r', enter: true }],
    ['interrupt', { text: 'echo x\r', interrupt: true }],
    ['mobile client', { text: 'echo x\r', client: { id: 'mobile-1', type: 'mobile' } }],
    ['query reply', { text: 'echo x\r', inputKind: 'query-reply' }]
  ])('rejects an invalid Quick Command shape: %s', async (_label, extra) => {
    const sendTerminal = vi.fn()
    const runtime = makeRuntime({ sendTerminal })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        terminal: 'terminal-1',
        quickCommand: true,
        client: { id: 'orca-desktop', type: 'desktop' },
        ...extra
      })
    )

    expect(response.ok).toBe(false)
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('routes an explicit CLI agent prompt through settled prompt delivery', async () => {
    const sendTerminal = vi.fn()
    const sendTerminalAgentPrompt = vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      accepted: true,
      bytesWritten: 19
    })
    const runtime = makeRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      isTerminalRunningSettledPromptAgent: vi.fn().mockResolvedValue(true),
      sendTerminal,
      sendTerminalAgentPrompt
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        terminal: 'terminal-1',
        text: 'review this change',
        enter: true,
        agentPrompt: true,
        client: { id: 'orca-cli', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    expect(runtime.isTerminalRunningSettledPromptAgent).toHaveBeenCalledWith('terminal-1')
    expect(sendTerminalAgentPrompt).toHaveBeenCalledWith('terminal-1', 'review this change', {
      beforeWrite: expect.any(Function),
      signal: undefined
    })
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('preserves direct input when the CLI target is not a proven settlement agent', async () => {
    const sendTerminal = vi.fn().mockResolvedValue({
      handle: 'terminal-1',
      accepted: true,
      bytesWritten: 7
    })
    const sendTerminalAgentPrompt = vi.fn()
    const runtime = makeRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      isTerminalRunningSettledPromptAgent: vi.fn().mockResolvedValue(false),
      sendTerminal,
      sendTerminalAgentPrompt
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest({
        terminal: 'terminal-1',
        text: 'echo x',
        enter: true,
        agentPrompt: true,
        client: { id: 'orca-cli', type: 'desktop' }
      })
    )

    expect(response.ok).toBe(true)
    expect(sendTerminal).toHaveBeenCalledWith(
      'terminal-1',
      { text: 'echo x', enter: true, interrupt: false },
      { beforeWrite: expect.any(Function) }
    )
    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
})
