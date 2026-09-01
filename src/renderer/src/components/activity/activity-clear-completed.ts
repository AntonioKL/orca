import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { AgentStatusCacheIdentity } from '../../../../shared/agent-status-types'
import { threadStatusGroupId } from './activity-thread-grouping'
import type { AgentPaneThread } from './activity-thread-types'

export type ClearCompletedActivityPlan = {
  /** Panes whose activity gets a cleared-at cutoff stamped. */
  cutoffPatch: Record<string, number | null>
  /** Exact prior cutoff values (or null when absent) so undo restores byte-for-byte. */
  restorePatch: Record<string, number | null>
  /** Retained snapshots removed by the clear; undo re-retains them verbatim. */
  retainedSnapshots: RetainedAgentEntry[]
  /** Exact status identities cleared so deferred disk eviction cannot remove a later run. */
  cacheIdentities: AgentStatusCacheIdentity[]
  clearedThreadCount: number
}

/** A thread is clearable when it needs nothing from the user: completed or interrupted,
 *  with no fresh live working/monitoring/blocked/waiting state. */
export function isClearableActivityThread(thread: AgentPaneThread): boolean {
  const groupId = threadStatusGroupId(thread)
  return groupId === 'done' || groupId === 'interrupted'
}

export function planClearCompletedActivity(
  threads: readonly AgentPaneThread[],
  state: {
    activityClearedAtByPaneKey: Record<string, number>
    retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  }
): ClearCompletedActivityPlan {
  const cutoffPatch: Record<string, number | null> = {}
  const restorePatch: Record<string, number | null> = {}
  const retainedSnapshots: RetainedAgentEntry[] = []
  const cacheIdentities: AgentStatusCacheIdentity[] = []
  let clearedThreadCount = 0
  for (const thread of threads) {
    if (!isClearableActivityThread(thread)) {
      continue
    }
    clearedThreadCount += 1
    cutoffPatch[thread.paneKey] = thread.latestTimestamp
    restorePatch[thread.paneKey] = state.activityClearedAtByPaneKey[thread.paneKey] ?? null
    const retained = state.retainedAgentsByPaneKey[thread.paneKey]
    if (retained) {
      retainedSnapshots.push(retained)
      const entry = retained.entry
      cacheIdentities.push({
        paneKey: thread.paneKey,
        state: entry.state,
        prompt: entry.prompt,
        ...(entry.agentType !== undefined ? { agentType: entry.agentType } : {}),
        ...(entry.tabId !== undefined ? { tabId: entry.tabId } : {}),
        ...(entry.worktreeId !== undefined ? { worktreeId: entry.worktreeId } : {}),
        ...(entry.connectionId !== undefined ? { connectionId: entry.connectionId } : {}),
        receivedAt: entry.updatedAt,
        stateStartedAt: entry.stateStartedAt
      })
    }
  }
  return { cutoffPatch, restorePatch, retainedSnapshots, cacheIdentities, clearedThreadCount }
}

/**
 * Clear completed/interrupted activity threads with an undo window.
 *
 * Live agent status, resume identity, and attention/working rows are untouched:
 * clearing stamps per-pane cutoffs (persisted UI) and removes retained completed
 * snapshots. The identity-checked main-process cache eviction is deferred until
 * the undo toast closes so Undo can restore everything losslessly.
 */
export function clearCompletedActivity(threads: readonly AgentPaneThread[]): boolean {
  const state = useAppStore.getState()
  const plan = planClearCompletedActivity(threads, state)
  if (plan.clearedThreadCount === 0) {
    return false
  }
  state.applyActivityClearedAt(plan.cutoffPatch)
  const introducedSuppressorLiveEntries = new Map(
    plan.retainedSnapshots.flatMap((retained) => {
      const paneKey = retained.entry.paneKey
      const liveEntry = state.agentStatusByPaneKey[paneKey]
      return liveEntry && !state.retentionSuppressedPaneKeys[paneKey]
        ? ([[paneKey, liveEntry]] as const)
        : []
    })
  )
  state.dismissRetainedAgents(plan.retainedSnapshots.map((retained) => retained.entry.paneKey))

  let undone = false
  let dropped = false
  const dropRetainedFromDiskCache = (): void => {
    if (undone || dropped) {
      return
    }
    dropped = true
    for (const identity of plan.cacheIdentities) {
      window.api?.agentStatus?.dropPersisted?.(identity)
    }
  }
  toast(
    plan.clearedThreadCount === 1
      ? translate('auto.components.activity.clearCompleted.clearedOne', 'Cleared 1 completed agent')
      : translate(
          'auto.components.activity.clearCompleted.clearedMany',
          'Cleared {{value0}} completed agents',
          { value0: plan.clearedThreadCount }
        ),
    {
      action: {
        label: translate('auto.components.activity.clearCompleted.undo', 'Undo'),
        onClick: () => {
          undone = true
          const current = useAppStore.getState()
          const retainedByPaneKey = new Map(
            plan.retainedSnapshots.map((retained) => [retained.entry.paneKey, retained])
          )
          const restorePatch: Record<string, number | null> = {}
          const snapshotsToRestore: RetainedAgentEntry[] = []
          const suppressorPaneKeysToClear: string[] = []
          for (const paneKey of Object.keys(plan.restorePatch)) {
            const currentLive = current.agentStatusByPaneKey?.[paneKey]
            const currentRetained = current.retainedAgentsByPaneKey[paneKey]
            const clearedSnapshot = retainedByPaneKey.get(paneKey)
            const cutoffStillOwned =
              current.activityClearedAtByPaneKey[paneKey] === plan.cutoffPatch[paneKey]
            if (cutoffStillOwned) {
              restorePatch[paneKey] = plan.restorePatch[paneKey] ?? null
            }
            if (
              cutoffStillOwned &&
              introducedSuppressorLiveEntries.get(paneKey) === currentLive &&
              current.retentionSuppressedPaneKeys[paneKey]
            ) {
              suppressorPaneKeysToClear.push(paneKey)
            }
            if (currentLive || (currentRetained && currentRetained !== clearedSnapshot)) {
              continue
            }
            if (clearedSnapshot && !currentRetained) {
              snapshotsToRestore.push(clearedSnapshot)
            }
          }
          current.applyActivityClearedAt(restorePatch)
          current.clearRetentionSuppressedPaneKeys(suppressorPaneKeysToClear)
          if (snapshotsToRestore.length > 0) {
            current.retainAgents(snapshotsToRestore)
          }
        }
      },
      onDismiss: dropRetainedFromDiskCache,
      onAutoClose: dropRetainedFromDiskCache
    }
  )
  return true
}
