import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UNMANAGED_POST_CONFIRMATION_WINDOW_MS,
  UnmanagedStatusExtensionFence
} from './unmanaged-status-extension-fence'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const LAUNCH_TOKEN = 'launch-token-abc'

describe('unmanaged-extension fence hold window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds for the shipped window by default, not for whatever a seam last set', () => {
    // Why this test exists: every other window test runs on the 40ms seam, so the shipped
    // constant had no reader at all — an edit to it, or to the constructor default, stayed green.
    // Fake timers keep that real 30s bounded to nothing.
    const fence = new UnmanagedStatusExtensionFence()
    const released: string[] = []
    try {
      expect(fence.classify(PANE, 'omp', LAUNCH_TOKEN)).toBe('managed')
      expect(
        fence.classify(PANE, 'omp', undefined, () => {
          released.push('agent_end')
        })
      ).toBe('held')
      vi.advanceTimersByTime(UNMANAGED_POST_CONFIRMATION_WINDOW_MS - 1)
      expect(released).toEqual([])
      vi.advanceTimersByTime(1)
      expect(released).toEqual(['agent_end'])
    } finally {
      fence.dispose()
    }
  })

  it('keeps the window between the supersede band and the point Orca stops believing “working”', () => {
    // Why bounds rather than the literal: the value is only justified by two other numbers.
    // Under a second it would race the managed copy's own superseding post; at or past the stale
    // cutoff the hold would outlive the claim it exists to protect.
    expect(UNMANAGED_POST_CONFIRMATION_WINDOW_MS).toBeGreaterThan(1_000)
    expect(UNMANAGED_POST_CONFIRMATION_WINDOW_MS).toBeLessThan(AGENT_STATUS_STALE_AFTER_MS)
  })
})
