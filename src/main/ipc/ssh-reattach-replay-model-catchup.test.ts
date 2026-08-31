import { describe, expect, it, vi } from 'vitest'
import { applySshReattachReplayModelCatchUp } from './ssh-reattach-replay-model-catchup'

describe('SSH reattach replay model catch-up', () => {
  it('appends only the relay-withheld suffix for an existing SSH model', () => {
    const append = vi.fn(() => true)
    const fence = { ptyId: 'ssh:host@@pty-1', sequence: 4 }
    const applied = applySshReattachReplayModelCatchUp({
      runtime: { hasHeadlessTerminal: () => true, appendHeadlessTerminalCatchUp: append },
      ptyId: fence.ptyId,
      isReattach: true,
      replay: 'before|during',
      replayUnseenChars: 'during'.length,
      seededFromReplay: false,
      modelIngestFence: fence
    })
    expect(applied).toBe(true)
    expect(append).toHaveBeenCalledWith(fence.ptyId, 'during', 4)
    expect(fence.consumed).toBe(true)
  })

  it('refuses a moved fence or non-SSH replay', () => {
    const append = vi.fn(() => true)
    const args = {
      runtime: { hasHeadlessTerminal: () => true, appendHeadlessTerminalCatchUp: append },
      ptyId: 'daemon-pty',
      isReattach: true,
      replay: 'tail',
      replayUnseenChars: 4,
      seededFromReplay: false,
      modelIngestFence: { ptyId: 'daemon-pty', sequence: 1 }
    }
    expect(applySshReattachReplayModelCatchUp(args)).toBe(false)
    expect(append).not.toHaveBeenCalled()
  })
})
