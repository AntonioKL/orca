import { describe, expect, it } from 'vitest'
import {
  createTerminalInputOrderingLane,
  TERMINAL_INPUT_ORDERING_LANE_MAX_PENDING
} from './terminal-input-ordering-lane'

describe('terminal input ordering lane', () => {
  it('keeps trailing input and repeated quick commands in invocation order', async () => {
    const lane = createTerminalInputOrderingLane()
    const events: string[] = []
    let releaseFirst!: () => void
    const first = lane.enqueueQuickCommand(
      () =>
        new Promise<boolean>((resolve) => {
          events.push('quick-1-start')
          releaseFirst = () => {
            events.push('quick-1-end')
            resolve(true)
          }
        })
    )
    expect(lane.enqueueInput(() => (events.push('typed-after-1'), true))).toBe(true)
    const second = lane.enqueueQuickCommand(async () => {
      events.push('quick-2')
      return true
    })
    expect(lane.enqueueInput(() => (events.push('typed-after-2'), true))).toBe(true)

    await Promise.resolve()
    expect(events).toEqual(['quick-1-start'])
    releaseFirst()
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(events).toEqual([
      'quick-1-start',
      'quick-1-end',
      'typed-after-1',
      'quick-2',
      'typed-after-2'
    ])
  })

  it('bounds deferred input while a quick command is pending', async () => {
    const lane = createTerminalInputOrderingLane()
    let release!: () => void
    const pending = lane.enqueueQuickCommand(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true)
        })
    )
    for (let index = 0; index < TERMINAL_INPUT_ORDERING_LANE_MAX_PENDING; index += 1) {
      expect(lane.enqueueInput(() => true)).toBe(true)
    }
    expect(lane.enqueueInput(() => true)).toBe(false)
    release()
    await expect(pending).resolves.toBe(true)
  })
})
