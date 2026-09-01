import { describe, expect, it } from 'vitest'
import { SshPtyClosedGenerationRanges } from './ssh-pty-closed-generation-ranges'

// Provider generations come from one process-global counter shared by every SSH target
// (ssh-pty-output-intake-registry.ts), so lower-numbered generations are routinely still live on a
// different host. The closed set must answer exactly; a high-water approximation would reject a
// healthy target's output the moment any other target disconnected.
describe('closed provider generations across concurrent SSH targets', () => {
  it('keeps a lower live generation admissible after a higher one closes', () => {
    const closed = new SshPtyClosedGenerationRanges()

    // Host A holds generation 1 and stays connected; host B holds 2 and disconnects.
    closed.add(2)

    expect(closed.has(2)).toBe(true)
    expect(closed.has(1)).toBe(false)
  })

  it('stays flat across a long monotonic run of reconnects', () => {
    // The leak this replaces: one retained entry per relay reconnect, forever.
    const closed = new SshPtyClosedGenerationRanges()
    for (let generation = 1; generation <= 100_000; generation += 1) {
      closed.add(generation)
    }

    expect(closed.size).toBe(1)
    expect(closed.has(100_000)).toBe(true)
    expect(closed.has(100_001)).toBe(false)
  })
})
