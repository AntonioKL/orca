// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveTerminalSplitSourceAuthority } from './orca-runtime-resolve-terminal-split-source-authority'
import {
  runtimeWorktreeIdentityKey,
  runtimeWorktreeIdsEqual
} from './runtime-worktree-path-identity'
import { teardownRpcDeadline } from './worktree-teardown'
import type {
  RuntimeWorktreeTerminalCloseResult,
  RuntimeWorktreeTerminalSleepResult
} from '../../shared/runtime-types'
import type { WorktreeTerminalMutationKind } from './worktree-terminal-mutation-lock'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from './workspace-session-failed-write-rollback'
import { parseExecutionHostId } from '../../shared/execution-host'
import { worktreePtyBelongsToHost, type WorktreePtyHostFence } from './worktree-pty-host-fence'
import { summarizeWorktreePtyStopVerdict } from './worktree-pty-stop-verdict'

export class OrcaRuntimeWithStopTerminalsForWorktree extends OrcaRuntimeWithResolveTerminalSplitSourceAuthority {
  private collectConnectedWorktreePtyIds(
    worktreeId: string,
    hostFence: WorktreePtyHostFence
  ): Set<string> {
    const ptyIds = new Set<string>()
    for (const leaf of this.leaves.values()) {
      if (
        runtimeWorktreeIdsEqual(leaf.worktreeId, worktreeId) &&
        leaf.ptyId &&
        worktreePtyBelongsToHost(leaf.ptyId, this.ptysById.get(leaf.ptyId)?.connectionId, hostFence)
      ) {
        ptyIds.add(leaf.ptyId)
      }
    }
    for (const pty of this.ptysById.values()) {
      if (
        runtimeWorktreeIdsEqual(pty.worktreeId, worktreeId) &&
        pty.connected &&
        worktreePtyBelongsToHost(pty.ptyId, pty.connectionId, hostFence)
      ) {
        ptyIds.add(pty.ptyId)
      }
    }
    return ptyIds
  }

  async closeTerminalsForWorktree(
    worktreeSelector: string
  ): Promise<RuntimeWorktreeTerminalCloseResult> {
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    const repo = this.store?.getRepo?.(worktree.repoId)
    const parsedHost = parseExecutionHostId(worktree.hostId)
    const hostFence =
      parsedHost?.kind === 'runtime'
        ? { resolvedRuntimeEnvironmentId: parsedHost.environmentId }
        : {
            resolvedConnectionId:
              repo?.connectionId ?? (parsedHost?.kind === 'ssh' ? parsedHost.targetId : null)
          }

    return await this.runWorktreeTerminalMutation(worktree.id, async () => {
      const snapshot = await this.listMobileSessionTabs(`id:${worktree.id}`)
      const targetPtyIds = this.collectConnectedWorktreePtyIds(worktree.id, hostFence)
      const parentTabIds = [
        ...new Set(
          snapshot.tabs.flatMap((tab) => (tab.type === 'terminal' ? [tab.parentTabId] : []))
        )
      ]
      let closed = 0
      for (const parentTabId of parentTabIds) {
        const result = await this.closeMobileSessionTab(`id:${worktree.id}`, parentTabId, {
          reason: 'user',
          force: true,
          localPtyTeardownOwnedExternally: true
        })
        if (result.refused) {
          throw new Error(result.refusalReason ?? 'terminal_close_refused')
        }
        closed += 1
      }
      this.clearWorktreeTerminalResumeRecords(worktree.id, parentTabIds)
      const { stopped } = await this.stopTerminalsForWorktree(`id:${worktree.id}`, {
        resolvedWorktreeId: worktree.id,
        ...hostFence
      })
      const ptyStop = summarizeWorktreePtyStopVerdict(
        targetPtyIds,
        (ptyId) => this.getPtyLivenessVerdict(ptyId),
        (ptyId) => this.ptysById.get(ptyId)?.connected === true
      )
      return {
        closed,
        stopped,
        retiredSurfaces: true,
        ...ptyStop
      }
    })
  }

  private clearWorktreeTerminalResumeRecords(
    worktreeId: string,
    closedTabIds: readonly string[]
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session) {
      return
    }
    const sleepingAgentSessionsByPaneKey = Object.fromEntries(
      Object.entries(session.sleepingAgentSessionsByPaneKey ?? {}).filter(
        ([, record]) => record.worktreeId !== worktreeId
      )
    )
    const terminalPtyIncarnationsByPaneKey = Object.fromEntries(
      Object.entries(session.terminalPtyIncarnationsByPaneKey ?? {}).filter(
        ([paneKey]) => !closedTabIds.some((tabId) => paneKey.startsWith(`${tabId}:`))
      )
    )
    const remainingTerminalRows = session.tabsByWorktree[worktreeId] ?? []
    const remainingUnifiedTerminalTabs = (session.unifiedTabs?.[worktreeId] ?? []).filter(
      (tab) => tab.contentType === 'terminal'
    )
    if (remainingTerminalRows.length > 0 || remainingUnifiedTerminalTabs.length > 0) {
      throw new Error('terminal_close_incomplete')
    }
    const hasChanges =
      Object.keys(sleepingAgentSessionsByPaneKey).length !==
        Object.keys(session.sleepingAgentSessionsByPaneKey ?? {}).length ||
      Object.keys(terminalPtyIncarnationsByPaneKey).length !==
        Object.keys(session.terminalPtyIncarnationsByPaneKey ?? {}).length
    if (!hasChanges) {
      return
    }
    if (!this.store?.setWorkspaceSession || !this.store.flushOrThrow) {
      throw new Error('workspace_session_unavailable')
    }
    const next: WorkspaceSessionState = {
      ...session,
      sleepingAgentSessionsByPaneKey,
      terminalPtyIncarnationsByPaneKey
    }
    this.setWorkspaceSessionForWorktree(worktreeId, next)
    const staged = this.getWorkspaceSessionForWorktree(worktreeId)
    try {
      this.store.flushOrThrow()
    } catch (error) {
      const current = this.getWorkspaceSessionForWorktree(worktreeId)
      if (staged && current) {
        const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(session, staged, current)
        if (rolledBack !== current) {
          this.setWorkspaceSessionForWorktree(worktreeId, rolledBack)
        }
      }
      throw error
    }
  }

  async stopTerminalsForWorktree(
    worktreeSelector: string,
    options: {
      deadline?: number
      stopPty?: (
        ptyId: string,
        stop: () => Promise<boolean>
      ) => Promise<{ stopped: boolean; owner: boolean }>
      /** Authoritative id for an orphan whose selector no longer resolves. */
      resolvedWorktreeId?: string
      resolvedConnectionId?: string | null
      resolvedRuntimeEnvironmentId?: string
    } = {}
  ): Promise<{ stopped: number }> {
    // Why: this mutates live PTYs, so reject while the graph is reloading rather than act on cached leaf ownership.
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = options.resolvedWorktreeId
      ? { id: options.resolvedWorktreeId }
      : await this.resolveWorktreeSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      return { stopped: 0 }
    }
    // Preserve folder-instance suffixes while normalizing cross-platform path spelling.
    const ptyIds = this.collectConnectedWorktreePtyIds(worktree.id, options)

    let stopped = 0
    for (const ptyId of ptyIds) {
      if (options.deadline !== undefined && Date.now() >= options.deadline) {
        break
      }
      const stop = async (): Promise<boolean> => {
        if (options.deadline !== undefined && Date.now() >= options.deadline) {
          return false
        }
        try {
          // Why: terminal.stop is a durable receipt; wait for provider exit so
          // onPtyExit de-persists the tab before returning.
          if (this.ptyController?.stopAndWait) {
            // Why: the RPC deadline makes shutdown/list RPCs settle before the sweep deadline.
            if (options.deadline !== undefined) {
              return await this.ptyController.stopAndWait(ptyId, {
                deadlineMs: teardownRpcDeadline(options.deadline)
              })
            }
            return await this.ptyController.stopAndWait(ptyId)
          }
          return Boolean(this.ptyController?.kill(ptyId))
        } catch (error) {
          // A worktree sweep is best-effort per PTY; continue after provider errors.
          console.warn(`[runtime] failed to stop terminal ${ptyId}`, error)
          return false
        }
      }
      const stopResult = options.stopPty
        ? await options.stopPty(ptyId, stop)
        : { stopped: await stop(), owner: true }
      if (stopResult.owner && stopResult.stopped) {
        stopped += 1
      }
    }
    return { stopped }
  }

  async sleepTerminalsForWorktree(
    worktreeSelector: string
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const existing = this.terminalSleepByWorktreeId.get(worktree.id)
    if (existing) {
      return await existing
    }

    const sleeping = this.sleepResolvedWorktreeTerminals(worktree)
    this.terminalSleepByWorktreeId.set(worktree.id, sleeping)
    try {
      return await sleeping
    } finally {
      if (this.terminalSleepByWorktreeId.get(worktree.id) === sleeping) {
        this.terminalSleepByWorktreeId.delete(worktree.id)
      }
    }
  }

  async acquireWorktreeTerminalSpawn(worktreeId?: string): Promise<() => void> {
    if (!worktreeId) {
      return () => {}
    }
    const release = await this.acquireWorktreeTerminalMutation(worktreeId, 'shared')
    const key = runtimeWorktreeIdentityKey(worktreeId)
    const sleepState = this.terminalSleepStateByWorktreeId.get(key)
    if (sleepState?.phase === 'sleeping' || sleepState?.phase === 'partial') {
      this.terminalSleepStateByWorktreeId.delete(key)
      this.emitClientEvent({
        type: 'worktreeTerminalSleepState',
        worktreeId: sleepState.worktreeId,
        generation: sleepState.generation,
        phase: 'woken',
        ptyIds: sleepState.ptyIds,
        terminalHandles: sleepState.terminalHandles
      })
    }
    return release
  }

  protected async runWorktreeTerminalMutation<T>(
    worktreeId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    // Why exclusive: adoption reconciles this worktree's terminal records, so
    // it must not interleave with a spawn registering a pty or with a sleep.
    const release = await this.acquireWorktreeTerminalMutation(worktreeId, 'exclusive')
    try {
      return await operation()
    } finally {
      release()
    }
  }

  protected async acquireWorktreeTerminalMutation(
    worktreeId: string,
    kind: WorktreeTerminalMutationKind,
    deadline?: number
  ): Promise<() => void> {
    return await this.terminalMutationLock.acquire(
      runtimeWorktreeIdentityKey(worktreeId),
      kind,
      deadline
    )
  }
}
