import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../shared/runtime-types'
import { waitForHeadlessAutomationCompletion } from './headless-completion-wait'

const blocked = {
  handle: 'terminal-1',
  condition: 'tui-idle',
  satisfied: false,
  status: 'running',
  exitCode: null,
  blockedReason: 'agent-approval-prompt'
} as RuntimeTerminalWait

const completed = {
  handle: 'terminal-1',
  condition: 'tui-idle',
  satisfied: true,
  status: 'running',
  exitCode: null
} as RuntimeTerminalWait

afterEach(() => vi.useRealTimers())

describe('waitForHeadlessAutomationCompletion', () => {
  it('keeps watching after a recoverable prompt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const waitForTerminal = vi.fn().mockResolvedValueOnce(blocked).mockResolvedValueOnce(completed)

    const resultPromise = waitForHeadlessAutomationCompletion(
      { waitForTerminal },
      'terminal-1',
      5_000
    )
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(resultPromise).resolves.toBe(completed)
    expect(waitForTerminal).toHaveBeenCalledTimes(2)
  })

  it('bounds prompt rechecks by the completion deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const waitForTerminal = vi.fn().mockResolvedValue(blocked)

    const resultPromise = waitForHeadlessAutomationCompletion(
      { waitForTerminal },
      'terminal-1',
      100
    )
    const rejection = expect(resultPromise).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(100)

    await rejection
    expect(waitForTerminal).toHaveBeenCalledTimes(1)
  })
})
