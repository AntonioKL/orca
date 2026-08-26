import { describe, expect, it, vi } from 'vitest'
import { claudeProcessIdentity } from './claude-structured-owner-identity'

const IDENTITY = {
  sessionId: 'session-identity',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'claude' as const,
  providerHandle: { kind: 'claude' as const, sessionId: 'provider-1', leafUuid: null }
}

describe('claude process identity', () => {
  it('records the observed start time alongside the spawn token', async () => {
    await expect(
      claudeProcessIdentity(
        { identity: IDENTITY, spawnToken: 'spawn-a', pid: 4242 },
        async () => 123
      )
    ).resolves.toEqual({
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 123,
      spawnToken: 'spawn-a'
    })
  })

  it('retries a failed start-time read before giving up', async () => {
    const readStartTime = vi
      .fn<(pid: number) => Promise<number | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(456)

    await expect(
      claudeProcessIdentity({ identity: IDENTITY, spawnToken: 'spawn-a', pid: 4242 }, readStartTime)
    ).resolves.toMatchObject({ processStartTimeMs: 456 })
    expect(readStartTime).toHaveBeenCalledTimes(3)
  })

  it('refuses an owner whose start time is unreadable', async () => {
    const readStartTime = vi.fn(async () => null)

    await expect(
      claudeProcessIdentity({ identity: IDENTITY, spawnToken: 'spawn-a', pid: 4242 }, readStartTime)
    ).rejects.toThrow('start time')
    expect(readStartTime).toHaveBeenCalledTimes(3)
  })
})
