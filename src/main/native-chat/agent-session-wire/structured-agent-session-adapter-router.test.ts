import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'

function adapterOf(
  releaseAcquisition: StructuredAgentSessionAdapter['releaseAcquisition']
): StructuredAgentSessionAdapter {
  return {
    acquire: vi.fn(async () => ({ process: { pid: 1 } }) as never),
    releaseAcquisition,
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  } as unknown as StructuredAgentSessionAdapter
}

describe('StructuredAgentSessionAdapterRouter.releaseAcquisition', () => {
  it('drops the owner even when its release reports a typed failure', async () => {
    const failure = new Error('root exited')
    const claude = adapterOf(vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(false))
    const codex = adapterOf(vi.fn(async () => false))
    const router = new StructuredAgentSessionAdapterRouter({ claude, codex }, async () => {})
    const identity = { sessionId: 'session-1', agent: 'claude' } as never
    await router.acquire({ identity, fence: 1, spawnToken: 'spawn-1' })

    await expect(router.releaseAcquisition({ sessionId: 'session-1' })).rejects.toBe(failure)
    // With no owner left, a later release asks every adapter instead of the stale one.
    await expect(router.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(false)
    expect(claude.releaseAcquisition).toHaveBeenCalledTimes(2)
    expect(codex.releaseAcquisition).toHaveBeenCalledTimes(1)
  })
})
