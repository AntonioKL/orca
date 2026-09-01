import { ipcMain } from 'electron'
import { agentHookServer, isValidPaneKey } from '../agent-hooks/server'
import {
  AGENT_STATUS_MAX_FIELD_LENGTH,
  AGENT_STATUS_STATES,
  AGENT_TYPE_MAX_LENGTH,
  type AgentStatusCacheIdentity
} from '../../shared/agent-status-types'
import {
  clearMigrationUnsupportedPtysByTabPrefix,
  clearMigrationUnsupportedPtysForPaneKey
} from '../agent-hooks/migration-unsupported-pty-state'
import { isValidAgentStatusDropTabId } from './agent-status-ipc-boundary'

/**
 * The renderer-initiated ways a status row goes away. All fire-and-forget
 * (`ipcRenderer.send` → `ipcMain.on`), so none round-trips a response; removing the
 * listeners first keeps re-registration safe.
 *
 * They are NOT interchangeable. A dismissal keeps the pane's per-pane caches because its agent may
 * still be alive; a confirmed process exit must take them too, or a surviving Claude latch resolves
 * the pane's next event straight back to `working`.
 */
export function registerAgentStatusRowTeardownIpcHandlers(): void {
  ipcMain.removeAllListeners('agentStatus:drop')
  ipcMain.removeAllListeners('agentStatus:dropPersisted')
  ipcMain.removeAllListeners('agentStatus:reconcileEndedProcess')
  ipcMain.removeAllListeners('agentStatus:dropByTabPrefix')

  ipcMain.on('agentStatus:drop', (_event, paneKey: unknown) => {
    if (typeof paneKey !== 'string' || !isValidPaneKey(paneKey)) {
      return
    }
    try {
      // Why: dropStatusEntry (not clearPaneState) is correct here — the user is
      // dismissing a status row, not tearing down a PTY. clearPaneState would also
      // wipe the per-pane prompt/tool caches, which the next hook event for that
      // (still-alive) pane needs to render a coherent row.
      agentHookServer.dropStatusEntry(paneKey)
      clearMigrationUnsupportedPtysForPaneKey(paneKey)
    } catch (err) {
      console.warn('[agent-hooks] dropStatusEntry failed:', err)
    }
  })

  ipcMain.on('agentStatus:dropPersisted', (_event, request: unknown) => {
    if (!isValidAgentStatusCacheIdentity(request)) {
      return
    }
    try {
      if (agentHookServer.dropPersistedStatusEntry(request)) {
        clearMigrationUnsupportedPtysForPaneKey(request.paneKey)
      }
    } catch (err) {
      console.warn('[agent-hooks] dropPersistedStatusEntry failed:', err)
    }
  })

  ipcMain.on('agentStatus:reconcileEndedProcess', (_event, paneKey: unknown) => {
    if (typeof paneKey !== 'string' || !isValidPaneKey(paneKey)) {
      return
    }
    try {
      // Why: a process-table-confirmed agent exit is exactly the case the dismissal above excludes
      // — the pane's agent is NOT still alive — so its latches must go with the row (STA-4612).
      agentHookServer.reconcileEndedProcessForPaneKeys([paneKey], {
        // Why: this route only fires on a confirmed shell foreground, so the PTY outlived the
        // agent. The row's resume identity is still usable in that very pane — only its live
        // claims are dead.
        preserveResumeIdentity: true
      })
      clearMigrationUnsupportedPtysForPaneKey(paneKey)
    } catch (err) {
      console.warn('[agent-hooks] reconcileEndedProcessForPaneKeys failed:', err)
    }
  })

  ipcMain.on('agentStatus:dropByTabPrefix', (_event, tabId: unknown) => {
    if (!isValidAgentStatusDropTabId(tabId)) {
      return
    }
    try {
      agentHookServer.dropStatusEntriesByTabPrefix(tabId)
      clearMigrationUnsupportedPtysByTabPrefix(tabId)
    } catch (err) {
      console.warn('[agent-hooks] dropStatusEntriesByTabPrefix failed:', err)
    }
  })
}

function isValidAgentStatusCacheIdentity(value: unknown): value is AgentStatusCacheIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const request = value as Record<string, unknown>
  return (
    typeof request.paneKey === 'string' &&
    isValidPaneKey(request.paneKey) &&
    typeof request.state === 'string' &&
    (AGENT_STATUS_STATES as readonly string[]).includes(request.state) &&
    typeof request.prompt === 'string' &&
    request.prompt.length <= AGENT_STATUS_MAX_FIELD_LENGTH &&
    (request.agentType === undefined ||
      (typeof request.agentType === 'string' &&
        request.agentType.length > 0 &&
        request.agentType.length <= AGENT_TYPE_MAX_LENGTH)) &&
    (request.tabId === undefined ||
      (typeof request.tabId === 'string' && request.tabId.length > 0)) &&
    (request.worktreeId === undefined ||
      (typeof request.worktreeId === 'string' && request.worktreeId.length > 0)) &&
    (request.connectionId === undefined ||
      request.connectionId === null ||
      (typeof request.connectionId === 'string' && request.connectionId.length > 0)) &&
    typeof request.receivedAt === 'number' &&
    Number.isFinite(request.receivedAt) &&
    typeof request.stateStartedAt === 'number' &&
    Number.isFinite(request.stateStartedAt)
  )
}
