import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'

function adapterOf(
  closeSession: StructuredAgentSessionAdapter['closeSession']
): StructuredAgentSessionAdapter {
  return {
    acquire: vi.fn(async () => ({ process: { pid: 1 } }) as never),
    closeSession,
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  } as unknown as StructuredAgentSessionAdapter
}

describe('StructuredAgentSessionAdapterRouter.closeSession', () => {
  it('retains the owner when provider exit is unproven so close can retry', async () => {
    const closeSession = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const adapter = adapterOf(closeSession)
    const router = new StructuredAgentSessionAdapterRouter(
      { claude: adapter, codex: adapter },
      async () => {}
    )
    const identity = { sessionId: 'session-1', agent: 'claude' } as never
    await router.acquire({ identity, fence: 1, spawnToken: 'spawn-1' })

    await expect(router.closeSession('session-1')).resolves.toBe(false)
    await expect(router.closeSession('session-1')).resolves.toBe(true)
    expect(closeSession).toHaveBeenCalledTimes(2)
  })
})
