import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { threadStatusGroupId } from './activity-thread-grouping'
import type { AgentPaneThread } from './activity-thread-types'

export type ClearCompletedActivityPlan = {
  /** Panes whose activity gets a cleared-at cutoff stamped. */
  cutoffPatch: Record<string, number | null>
  /** Exact prior cutoff values (or null when absent) so undo restores byte-for-byte. */
  restorePatch: Record<string, number | null>
  /** Retained snapshots removed by the clear; undo re-retains them verbatim. */
  retainedSnapshots: RetainedAgentEntry[]
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
    }
  }
  return { cutoffPatch, restorePatch, retainedSnapshots, clearedThreadCount }
}

/**
 * Clear completed/interrupted activity threads with an undo window.
 *
 * Live agent status, resume identity, and attention/working rows are untouched:
 * clearing stamps per-pane cutoffs (persisted UI) and removes retained completed
 * snapshots. The persistent on-disk retained-cache drop is deferred until the
 * undo toast closes so Undo can restore everything losslessly.
 */
export function clearCompletedActivity(threads: readonly AgentPaneThread[]): boolean {
  const state = useAppStore.getState()
  const plan = planClearCompletedActivity(threads, state)
  if (plan.clearedThreadCount === 0) {
    return false
  }
  state.applyActivityClearedAt(plan.cutoffPatch)
  state.dismissRetainedAgents(plan.retainedSnapshots.map((retained) => retained.entry.paneKey))

  let undone = false
  let dropped = false
  const dropRetainedFromDiskCache = (): void => {
    if (undone || dropped) {
      return
    }
    dropped = true
    for (const retained of plan.retainedSnapshots) {
      window.api?.agentStatus?.drop?.(retained.entry.paneKey)
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
          current.applyActivityClearedAt(plan.restorePatch)
          if (plan.retainedSnapshots.length > 0) {
            current.retainAgents(plan.retainedSnapshots)
          }
        }
      },
      onDismiss: dropRetainedFromDiskCache,
      onAutoClose: dropRetainedFromDiskCache
    }
  )
  return true
}
