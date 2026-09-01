import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentPaneThread } from './activity-thread-types'

/** Every entry that can carry the pane's orchestration lineage, newest first. */
function candidateEntries(thread: AgentPaneThread): AgentStatusEntry[] {
  const entries: AgentStatusEntry[] = []
  if (thread.currentAgentEntry) {
    entries.push(thread.currentAgentEntry)
  }
  if (thread.latestEvent?.entry) {
    entries.push(thread.latestEvent.entry)
  }
  for (const event of thread.events) {
    entries.push(event.entry)
  }
  return entries
}

function resolveEntryParentPaneKey(
  entry: AgentStatusEntry,
  ownPaneKey: string,
  threadPaneKeys: ReadonlySet<string>,
  paneKeyByTerminalHandle: ReadonlyMap<string, string>
): string | undefined {
  const orch = entry.orchestration
  if (!orch) {
    return undefined
  }
  if (
    orch.parentPaneKey &&
    orch.parentPaneKey !== ownPaneKey &&
    threadPaneKeys.has(orch.parentPaneKey)
  ) {
    return orch.parentPaneKey
  }
  for (const handle of [orch.parentTerminalHandle, orch.coordinatorHandle]) {
    const parentPaneKey = handle ? paneKeyByTerminalHandle.get(handle) : undefined
    if (parentPaneKey && parentPaneKey !== ownPaneKey) {
      return parentPaneKey
    }
  }
  return undefined
}

/** A chain ending at a listed non-child thread is a real lineage; a cycle
 *  (malformed metadata) is not — its members stay top-level, like the dashboard tree. */
function ancestorChainReachesRoot(
  paneKey: string,
  parentByChildPaneKey: ReadonlyMap<string, string>
): boolean {
  const seen = new Set([paneKey])
  let current = paneKey
  for (;;) {
    const parent = parentByChildPaneKey.get(current)
    if (!parent) {
      return true
    }
    if (seen.has(parent)) {
      return false
    }
    seen.add(parent)
    current = parent
  }
}

/**
 * Pane keys of threads that are children of another currently listed thread.
 * Mirrors the dashboard's resolveAgentRowParentPaneKey rules: a parent reference
 * only counts while the parent thread still exists, so orphaned workers (their
 * coordinator pane closed) are promoted to top level instead of staying hidden
 * behind the child-agent filter.
 */
export function collectChildAgentPaneKeys(threads: readonly AgentPaneThread[]): Set<string> {
  const threadPaneKeys = new Set(threads.map((thread) => thread.paneKey))
  const paneKeyByTerminalHandle = new Map<string, string>()
  for (const thread of threads) {
    for (const entry of candidateEntries(thread)) {
      if (entry.terminalHandle) {
        if (!paneKeyByTerminalHandle.has(entry.terminalHandle)) {
          paneKeyByTerminalHandle.set(entry.terminalHandle, thread.paneKey)
        }
        break
      }
    }
  }

  const parentByChildPaneKey = new Map<string, string>()
  for (const thread of threads) {
    for (const entry of candidateEntries(thread)) {
      const parentPaneKey = resolveEntryParentPaneKey(
        entry,
        thread.paneKey,
        threadPaneKeys,
        paneKeyByTerminalHandle
      )
      if (parentPaneKey) {
        parentByChildPaneKey.set(thread.paneKey, parentPaneKey)
        break
      }
    }
  }

  const childPaneKeys = new Set<string>()
  for (const childPaneKey of parentByChildPaneKey.keys()) {
    if (ancestorChainReachesRoot(childPaneKey, parentByChildPaneKey)) {
      childPaneKeys.add(childPaneKey)
    }
  }
  return childPaneKeys
}
