import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { activeStructuredAgentSessionTurnId } from '../../../../shared/structured-agent-session-projection'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  getStructuredAgentSessionReadOwner,
  type StructuredAgentSessionReadSnapshot
} from './structured-agent-session-read-owner'

function useReadOwnerSnapshot(
  sessionId: string,
  target: RuntimeClientTarget
): {
  owner: ReturnType<typeof getStructuredAgentSessionReadOwner>
  snapshot: StructuredAgentSessionReadSnapshot
} {
  const owner = useMemo(
    () => getStructuredAgentSessionReadOwner(sessionId, target),
    [sessionId, target]
  )
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot)
  return { owner, snapshot }
}

export function useStructuredAgentSessionReadObservation(args: {
  sessionId: string
  target: RuntimeClientTarget
}): StructuredAgentSessionReadSnapshot {
  const { owner, snapshot } = useReadOwnerSnapshot(args.sessionId, args.target)
  const hasActiveTurn = activeStructuredAgentSessionTurnId(snapshot.state.items) !== null

  // Why: a background status projection must keep receiving the real settlement after its pane hides.
  useEffect(() => (hasActiveTurn ? owner.activate() : undefined), [hasActiveTurn, owner])

  return snapshot
}

export function useStructuredAgentSessionRead(args: {
  sessionId: string
  target: RuntimeClientTarget
  isVisible?: boolean
}) {
  const { sessionId, target, isVisible = true } = args
  const { owner, snapshot } = useReadOwnerSnapshot(sessionId, target)

  useEffect(() => (isVisible ? owner.activate() : undefined), [isVisible, owner])

  useEffect(() => {
    if (!isVisible) {
      return
    }
    const refresh = (): void => {
      if (document.hasFocus()) {
        owner.refresh()
      }
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [isVisible, owner])

  return {
    state: snapshot.state,
    loadingOlder: snapshot.loadingOlder,
    loadOlder: owner.loadOlder,
    providerSession: snapshot.providerSession,
    releasePendingTurn: owner.releasePendingTurn,
    retainPendingTurn: owner.retainPendingTurn
  }
}
