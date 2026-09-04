import { useCallback, useMemo, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  MOBILE_UNANCHORED_TURN_KEY,
  useMobileNativeChatTurnStatus,
  type NativeChatTurnStatus
} from './use-mobile-native-chat-turn-status'

export type MobileNativeChatTurnRow = {
  turnStatus: NativeChatTurnStatus | null
  turnExpanded: boolean
  onToggleTurn?: () => void
  activeTurnIsWorking: boolean
}

/** Owns the transcript's per-turn status rows and their disclosure state, and
 *  resolves what one list row needs. Bridge-lane chats pass `enabled: false` and
 *  keep their single three-dot working indicator instead. */
export function useMobileNativeChatTurnDisclosure({
  messages,
  enabled,
  isWorking
}: {
  messages: readonly NativeChatMessage[]
  enabled: boolean
  isWorking: boolean
}): {
  active: NativeChatTurnStatus | null
  /** True when the live turn has no user message to hang its status row under. */
  activeTurnIsUnanchored: boolean
  resolveRow: (index: number, message: NativeChatMessage) => MobileNativeChatTurnRow
} {
  const turnStatuses = useMobileNativeChatTurnStatus({
    messages,
    isWorking: enabled && isWorking
  })
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<string>>(() => new Set())
  const toggleExpandedTurn = useCallback((turnKey: string) => {
    setExpandedTurnIds((current) => {
      const next = new Set(current)
      if (!next.delete(turnKey)) {
        next.add(turnKey)
      }
      return next
    })
  }, [])
  // Why: a fresh closure per row per render defeats the message row's memo, and a
  // streaming turn re-renders the list ~20x/s. One stable handler per turn instead.
  const toggleHandlers = useRef(new Map<string, () => void>())
  const toggleHandlerFor = useCallback(
    (turnKey: string): (() => void) => {
      const existing = toggleHandlers.current.get(turnKey)
      if (existing) {
        return existing
      }
      const handler = (): void => toggleExpandedTurn(turnKey)
      toggleHandlers.current.set(turnKey, handler)
      return handler
    },
    [toggleExpandedTurn]
  )

  // Resolve each row's turn boundary once — a findLast per row is quadratic on a
  // long transcript.
  const turnKeys = useMemo(() => {
    let turnKey: string | undefined
    const keys = messages.map((message) => {
      if (message.role === 'user') {
        turnKey = message.id
      }
      return turnKey
    })
    // Drop handlers for turns that left the transcript so a long session does not
    // retain a closure per turn forever.
    const live = new Set(keys)
    for (const key of toggleHandlers.current.keys()) {
      if (!live.has(key)) {
        toggleHandlers.current.delete(key)
      }
    }
    return keys
  }, [messages])

  const { active, activeTurnKey, completedByTurn } = turnStatuses
  const resolveRow = useCallback(
    (index: number, message: NativeChatMessage): MobileNativeChatTurnRow => {
      const turnKey = turnKeys[index]
      const turnStatus =
        !enabled || message.role !== 'user'
          ? null
          : turnKey === activeTurnKey
            ? active
            : turnKey
              ? (completedByTurn[turnKey] ?? null)
              : null
      return {
        turnStatus,
        turnExpanded: turnKey ? expandedTurnIds.has(turnKey) : false,
        // Only a settled turn has anything to disclose; leaving the handler off
        // every other row keeps their props identity-stable.
        onToggleTurn:
          turnKey && turnStatus?.workedSeconds != null ? toggleHandlerFor(turnKey) : undefined,
        // A missing turn boundary is not evidence the turn ended; the session's
        // own working state stays authoritative.
        activeTurnIsWorking:
          enabled && (turnKey === undefined || turnKey === activeTurnKey) && isWorking
      }
    },
    [
      turnKeys,
      enabled,
      activeTurnKey,
      active,
      completedByTurn,
      expandedTurnIds,
      toggleHandlerFor,
      isWorking
    ]
  )

  return {
    active,
    activeTurnIsUnanchored:
      enabled && active != null && activeTurnKey === MOBILE_UNANCHORED_TURN_KEY,
    resolveRow
  }
}
