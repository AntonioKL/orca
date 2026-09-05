import { useCallback, useMemo, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  MOBILE_UNANCHORED_TURN_KEY,
  useMobileNativeChatTurnStatus,
  type NativeChatTurnStatus
} from './use-mobile-native-chat-turn-status'

const EMPTY_TURN_IDS: ReadonlySet<string> = new Set()
const EMPTY_TURN_KEYS: readonly undefined[] = []
const MAX_EXPANDED_TURNS = 128

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
  isWorking,
  scopeKey
}: {
  messages: readonly NativeChatMessage[]
  enabled: boolean
  isWorking: boolean
  /** Host/worktree/tab identity for timing and disclosure isolation. */
  scopeKey: string
}): {
  active: NativeChatTurnStatus | null
  /** True when the live turn has no user message to hang its status row under. */
  activeTurnIsUnanchored: boolean
  resolveRow: (index: number, message: NativeChatMessage) => MobileNativeChatTurnRow
} {
  const turnStatuses = useMobileNativeChatTurnStatus({
    messages,
    enabled,
    isWorking,
    scopeKey
  })
  const [expandedTurns, setExpandedTurns] = useState<{
    scopeKey: string
    turnIds: ReadonlySet<string>
  }>(() => ({ scopeKey, turnIds: new Set() }))
  const expandedTurnIds =
    expandedTurns.scopeKey === scopeKey ? expandedTurns.turnIds : EMPTY_TURN_IDS
  const toggleExpandedTurn = useCallback(
    (turnKey: string) => {
      setExpandedTurns((current) => {
        const next = new Set(current.scopeKey === scopeKey ? current.turnIds : [])
        if (!next.delete(turnKey)) {
          if (next.size >= MAX_EXPANDED_TURNS) {
            const oldest = next.values().next().value
            if (oldest) {
              next.delete(oldest)
            }
          }
          next.add(turnKey)
        }
        return { scopeKey, turnIds: next }
      })
    },
    [scopeKey]
  )
  // Why: a fresh closure per row per render defeats the message row's memo, and a
  // streaming turn re-renders the list ~20x/s. One stable handler per turn instead.
  const toggleHandlers = useRef<{
    scopeKey: string
    byTurn: Map<string, () => void>
  }>({ scopeKey, byTurn: new Map() })
  const toggleHandlerFor = useCallback(
    (turnKey: string): (() => void) => {
      if (toggleHandlers.current.scopeKey !== scopeKey) {
        toggleHandlers.current = { scopeKey, byTurn: new Map() }
      }
      const existing = toggleHandlers.current.byTurn.get(turnKey)
      if (existing) {
        return existing
      }
      const handler = (): void => toggleExpandedTurn(turnKey)
      toggleHandlers.current.byTurn.set(turnKey, handler)
      return handler
    },
    [scopeKey, toggleExpandedTurn]
  )

  // Resolve each row's turn boundary once — a findLast per row is quadratic on a
  // long transcript.
  const turnKeys = useMemo(() => {
    if (toggleHandlers.current.scopeKey !== scopeKey) {
      toggleHandlers.current = { scopeKey, byTurn: new Map() }
    }
    if (!enabled) {
      toggleHandlers.current.byTurn.clear()
      return EMPTY_TURN_KEYS
    }
    let turnKey: string | undefined
    const keys = messages.map((message) => {
      if (message.role === 'user') {
        turnKey = message.id
      }
      return turnKey
    })
    // Drop handlers for turns that left the transcript so a long session does not
    // retain a closure per turn forever.
    const live = new Set(keys.filter((key): key is string => key !== undefined))
    for (const key of toggleHandlers.current.byTurn.keys()) {
      if (!live.has(key)) {
        toggleHandlers.current.byTurn.delete(key)
      }
    }
    return keys
  }, [enabled, messages, scopeKey])

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
        // With no user boundary at all, the session's working state stays authoritative.
        activeTurnIsWorking:
          enabled &&
          isWorking &&
          (turnKey === activeTurnKey ||
            (turnKey === undefined && activeTurnKey === MOBILE_UNANCHORED_TURN_KEY))
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
