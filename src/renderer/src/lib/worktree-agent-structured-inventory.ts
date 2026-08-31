import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getStructuredAgentSessionTarget } from '@/runtime/structured-agent-session-target'

export type StructuredActivationInventory = {
  snapshot: RuntimeMobileSessionTabsResult
  ownerBySessionId: ReadonlyMap<
    string,
    {
      owner: 'native' | 'tui'
      terminal?: { paneKey: string; ptyId: string; tabId: string }
    }
  >
}

export async function readWorktreeStructuredActivationInventory(
  worktreeId: string
): Promise<false | StructuredActivationInventory> {
  if (typeof window === 'undefined') {
    return false
  }
  const target = getStructuredAgentSessionTarget(useAppStore.getState(), worktreeId)
  const result = await callRuntimeRpc<{ snapshots?: RuntimeMobileSessionTabsResult[] }>(
    target,
    'session.tabs.listAll',
    {}
  )
  const snapshot = (result.snapshots ?? []).find(
    (candidate) =>
      candidate.worktree === worktreeId &&
      candidate.tabs.some((tab) => tab.type === 'agent-session')
  )
  if (!snapshot) {
    return false
  }
  const ownerBySessionId = new Map<
    string,
    {
      owner: 'native' | 'tui'
      terminal?: { paneKey: string; ptyId: string; tabId: string }
    }
  >()
  await Promise.all(
    snapshot.tabs.flatMap((tab) =>
      tab.type === 'agent-session'
        ? [
            callRuntimeRpc<{
              owner?: unknown
              terminal?: { paneKey?: unknown; ptyId?: unknown; tabId?: unknown }
            }>(target, 'agentSession.handoffStatus', { sessionId: tab.sessionId })
              .then((status) => {
                if (status.owner === 'native') {
                  ownerBySessionId.set(tab.sessionId, { owner: 'native' })
                } else if (
                  status.owner === 'tui' &&
                  typeof status.terminal?.paneKey === 'string' &&
                  typeof status.terminal?.ptyId === 'string' &&
                  status.terminal.ptyId.length > 0 &&
                  typeof status.terminal.tabId === 'string'
                ) {
                  ownerBySessionId.set(tab.sessionId, {
                    owner: 'tui',
                    terminal: {
                      paneKey: status.terminal.paneKey,
                      ptyId: status.terminal.ptyId,
                      tabId: status.terminal.tabId
                    }
                  })
                }
              })
              .catch(() => undefined)
          ]
        : []
    )
  )
  return { snapshot, ownerBySessionId }
}
