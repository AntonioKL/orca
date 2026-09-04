import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { activeStructuredAgentSessionTurnId } from '../../../../shared/structured-agent-session-projection'

type TurnLifecycleItem = AgentJournalRenderItem & {
  body: Extract<AgentJournalRenderItem['body'], { kind: 'status' }> & {
    turnLifecycle: NonNullable<
      Extract<AgentJournalRenderItem['body'], { kind: 'status' }>['turnLifecycle']
    >
  }
}

function turnLifecycleItems(items: readonly AgentJournalRenderItem[]): TurnLifecycleItem[] {
  return items.filter(
    (item): item is TurnLifecycleItem =>
      item.body.kind === 'status' && Boolean(item.body.turnLifecycle)
  )
}

export function createStructuredAgentSessionPendingTurnRetentions(
  getState: () => {
    items: readonly AgentJournalRenderItem[]
    submissions: readonly AgentJournalSubmission[]
  }
): {
  dispose: () => void
  hasRetentions: () => boolean
  observe: () => void
  releaseObservedTurn: () => void
  release: (clientMessageId: string) => void
  retain: (clientMessageId: string, acquireActivation: () => () => void) => void
} {
  const retentions = new Map<
    string,
    {
      afterSequence: number
      release: () => void
      turnId: string | null
    }
  >()
  let observedActiveTurnId: string | null = null

  const observe = (): void => {
    if (retentions.size === 0) {
      return
    }
    const { items, submissions } = getState()
    for (const submission of submissions) {
      if (submission.dispatchState === 'rejected') {
        retentions.get(submission.clientMessageId)?.release()
      }
    }
    const lifecycleItems = turnLifecycleItems(items)
    const activeTurnId = activeStructuredAgentSessionTurnId(lifecycleItems)
    if (observedActiveTurnId && observedActiveTurnId !== activeTurnId) {
      for (const retention of retentions.values()) {
        if (retention.turnId === observedActiveTurnId) {
          retention.release()
          break
        }
      }
    }
    if (activeTurnId && activeTurnId !== observedActiveTurnId) {
      const runningSequence = lifecycleItems.findLast(
        (item) => item.body.turnLifecycle.turnId === activeTurnId
      )?.sequence
      for (const retention of retentions.values()) {
        if (
          retention.turnId === null &&
          runningSequence !== undefined &&
          runningSequence > retention.afterSequence
        ) {
          retention.turnId = activeTurnId
          break
        }
      }
    }
    if (!activeTurnId) {
      const claimedTurnIds = new Set(observedActiveTurnId ? [observedActiveTurnId] : [])
      for (const retention of retentions.values()) {
        if (retention.turnId !== null) {
          continue
        }
        const settled = lifecycleItems.find(
          (item) =>
            item.sequence > retention.afterSequence &&
            item.body.turnLifecycle.state !== 'running' &&
            !claimedTurnIds.has(item.body.turnLifecycle.turnId)
        )
        if (settled) {
          claimedTurnIds.add(settled.body.turnLifecycle.turnId)
          retention.release()
        }
      }
    }
    observedActiveTurnId = activeTurnId
  }

  return {
    dispose: () => {
      for (const retention of retentions.values()) {
        retention.release()
      }
    },
    hasRetentions: () => retentions.size > 0,
    observe,
    releaseObservedTurn: () => {
      if (!observedActiveTurnId) {
        return
      }
      for (const retention of retentions.values()) {
        if (retention.turnId === observedActiveTurnId) {
          retention.release()
          return
        }
      }
    },
    release: (clientMessageId) => retentions.get(clientMessageId)?.release(),
    retain: (clientMessageId, acquireActivation) => {
      if (retentions.has(clientMessageId)) {
        return
      }
      const lifecycleItems = turnLifecycleItems(getState().items)
      if (retentions.size === 0) {
        observedActiveTurnId = activeStructuredAgentSessionTurnId(lifecycleItems)
      }
      const releaseActivation = acquireActivation()
      const retention = {
        afterSequence: lifecycleItems.at(-1)?.sequence ?? -1,
        turnId: null as string | null,
        release: (): void => {
          if (!retentions.delete(clientMessageId)) {
            return
          }
          releaseActivation()
        }
      }
      retentions.set(clientMessageId, retention)
    }
  }
}
