import { describe, expect, it } from 'vitest'
import {
  resolveNativeChatHookState,
  resolveNativeChatMonitoringStatus
} from './use-native-chat-hook-status'

describe('resolveNativeChatHookState', () => {
  const now = 1_000_000

  it('does not treat a restored working row as live activity', () => {
    const entry = {
      state: 'working' as const,
      workingMode: undefined,
      updatedAt: now,
      restoredUnconfirmed: true
    }

    expect(resolveNativeChatHookState(entry, now)).toBeNull()
    expect(resolveNativeChatMonitoringStatus(entry, now)).toBe(false)
  })

  it('keeps confirmed working activity live', () => {
    expect(
      resolveNativeChatHookState(
        {
          state: 'working',
          workingMode: undefined,
          updatedAt: now,
          restoredUnconfirmed: false
        },
        now
      )
    ).toBe('working')
  })

  it('continues to suppress monitoring rows', () => {
    const entry = {
      state: 'working' as const,
      workingMode: 'monitoring' as const,
      updatedAt: now,
      restoredUnconfirmed: false
    }

    expect(resolveNativeChatHookState(entry, now)).toBeNull()
    expect(resolveNativeChatMonitoringStatus(entry, now)).toBe(true)
  })

  it('does not keep an expired working row live', () => {
    expect(
      resolveNativeChatHookState(
        {
          state: 'working',
          workingMode: undefined,
          updatedAt: now - 30 * 60 * 1000 - 1,
          restoredUnconfirmed: false
        },
        now
      )
    ).toBeNull()
  })

  it('does not show expired monitoring activity', () => {
    expect(
      resolveNativeChatMonitoringStatus(
        {
          state: 'working',
          workingMode: 'monitoring',
          updatedAt: now - 30 * 60 * 1000 - 1,
          restoredUnconfirmed: false
        },
        now
      )
    ).toBe(false)
  })
})
