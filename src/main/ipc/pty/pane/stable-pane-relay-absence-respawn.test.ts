import { describe, expect, it, vi } from 'vitest'
import {
  SSH_SESSION_EXPIRED_ERROR,
  SshPtyAbsentFromRelayError
} from '../../../providers/ssh-pty-errors'
import type { IPtyProvider } from '../../../providers/types'
import { spawnForStablePane, type StablePaneOwner } from './stable-owner'

const OWNER: StablePaneOwner = {
  tabId: 'tab-1',
  leafId: '1b3f2c4d-5e6a-4b7c-8d9e-0f1a2b3c4d5e',
  ptyId: 'ssh:conn-1@@pty-1'
}

function spawnAfterAttachRejection(error: unknown): {
  run: () => ReturnType<typeof spawnForStablePane>
  spawn: ReturnType<typeof vi.fn>
} {
  const spawn = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce({ id: 'ssh:conn-1@@pty-1', isReattach: false })
  return {
    spawn,
    run: () =>
      spawnForStablePane({
        runtime: undefined,
        provider: { spawn } as unknown as IPtyProvider,
        spawnOptions: { cols: 80, rows: 24 },
        owner: OWNER,
        connectionId: 'conn-1',
        resolveOwner: () => null
      })
  }
}

describe('stable pane adoption after the relay reports the PTY absent', () => {
  it('spawns fresh once the relay has positively answered for that id', async () => {
    const { run, spawn } = spawnAfterAttachRejection(
      new SshPtyAbsentFromRelayError(`${SSH_SESSION_EXPIRED_ERROR}: pty-1`)
    )

    const result = await run()

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ attachOnly: true })
    expect(spawn.mock.calls[1]?.[0]).not.toHaveProperty('sessionId')
    expect(result.owner).toBeNull()
  })

  // A restarted relay renumbers from pty-1, so the message alone cannot distinguish absence from a
  // lost link — only the class may authorise abandoning the binding.
  it.each([
    ['an expired session with no relay evidence', `${SSH_SESSION_EXPIRED_ERROR}: pty-1`],
    ['a lost link', 'SSH connection lost, reconnecting...'],
    ['a request timeout', 'Request "pty.attach" timed out after 10000ms']
  ])('keeps the binding and refuses to respawn after %s', async (_label, message) => {
    const { run, spawn } = spawnAfterAttachRejection(new Error(message))

    await expect(run()).rejects.toThrow(message)
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
