import { useEffect, useState } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  nativeChatTurnHasResponse,
  reduceNativeChatTurnTiming,
  selectNativeChatTurnStatuses,
  type NativeChatTurnStatus,
  type NativeChatTurnTimingByTurn
} from '../../../src/shared/native-chat-turn-status'

export type { NativeChatTurnStatus }

export const MOBILE_UNANCHORED_TURN_KEY = '__unanchored__'

/** Per-turn "Thinking / Working for N / Worked for N" timing, on the same shared
 *  state machine the desktop renderer uses so the two surfaces stamp turns alike. */
export function useMobileNativeChatTurnStatus({
  messages,
  isWorking,
  workingStartedAt
}: {
  messages: readonly NativeChatMessage[]
  isWorking: boolean
  workingStartedAt?: number | null
}): {
  active: NativeChatTurnStatus | null
  completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
  activeTurnKey: string
} {
  const latestUserIndex = messages.findLastIndex((message) => message.role === 'user')
  const hasCurrentTurnResponse = nativeChatTurnHasResponse(messages, latestUserIndex)
  const latestUserId = latestUserIndex !== -1 ? (messages[latestUserIndex]?.id ?? null) : null
  const activeTurnKey = latestUserId ?? MOBILE_UNANCHORED_TURN_KEY
  const [timingByTurn, setTimingByTurn] = useState<NativeChatTurnTimingByTurn>({})

  useEffect(() => {
    const validTurnKeys = new Set(
      messages.filter((message) => message.role === 'user').map((message) => message.id)
    )
    setTimingByTurn((current) =>
      reduceNativeChatTurnTiming(current, {
        activeTurnKey,
        validTurnKeys,
        isWorking,
        workingStartedAt,
        now: Date.now()
      })
    )
  }, [activeTurnKey, isWorking, messages, workingStartedAt])

  return {
    ...selectNativeChatTurnStatuses(timingByTurn, {
      activeTurnKey,
      isWorking,
      workingStartedAt,
      hasCurrentTurnResponse
    }),
    activeTurnKey
  }
}
