import type { StoreApi } from 'zustand'
import type {
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSnapshot
} from '../../../shared/remote-workspace-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { buildWorkspaceSessionPayload } from '../lib/workspace-session'
import type { AppState } from '../store/types'
import type {
  DirectSshPreparationInput,
  DirectSshPreparationOutcome,
  DirectSshPreparationToken
} from './direct-ssh-reconnect-coordinator'
import { buildDirectSshSnapshotApplyToken } from './direct-ssh-reconnect-coordinator'
import { resolveDirectSshTargetScope } from '../lib/direct-ssh-target-scope'
import {
  applyDirectSshRemoteWorkspaceSnapshot,
  type DirectSshSnapshotPlacement
} from './remote-workspace-snapshot-apply'
import { createUnplacedSnapshotRepull } from './remote-workspace-unplaced-snapshot-repull'

const WORKSPACE_HYDRATION_TIMEOUT_MS = 10_000

type RemoteWorkspaceApi = {
  get: (args: { targetId: string }) => Promise<RemoteWorkspaceSnapshot | null>
  setForConnectedTargets: (args: {
    session?: WorkspaceSessionState
    hydratedTargetIds?: string[]
  }) => Promise<{ targetId: string; result: RemoteWorkspacePatchResult }[]>
}

export type RemoteWorkspaceTargetSyncDeps = {
  store: Pick<StoreApi<AppState>, 'getState'>
  remoteWorkspace: RemoteWorkspaceApi
  getCurrentAuthority: (targetId: string) => DirectSshAuthority | null
  isPreparationTokenCurrent: (token: DirectSshPreparationToken) => boolean
  capturePreparationInput: (
    authority: DirectSshAuthority,
    reason: 'workspace-snapshot',
    snapshotRevision: number
  ) => Promise<DirectSshPreparationInput | null>
  prepareOnly: (input: DirectSshPreparationInput) => Promise<DirectSshPreparationOutcome>
  finalizeHydratedTerminals: (authority: DirectSshAuthority) => number
}

export type RemoteWorkspaceTargetSync = {
  syncAfterConnect: (token: DirectSshPreparationToken) => Promise<void>
  applyUnsolicitedSnapshot: (
    targetId: string,
    snapshot: RemoteWorkspaceSnapshot
  ) => Promise<DirectSshSnapshotPlacement>
  stop: () => void
}

function exactTargetWorktreeIds(state: AppState, authority: DirectSshAuthority): Set<string> {
  return resolveDirectSshTargetScope({
    targetId: authority.targetId,
    catalogRevision: 0,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  }).gitWorktreeIds
}

function applyPatchStatus(
  store: AppState,
  targetId: string,
  result: RemoteWorkspacePatchResult | undefined
): void {
  if (!result) {
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'offline',
      direction: 'push',
      lastSyncedAt: Date.now(),
      message: translate('auto.hooks.useIpcEvents.2fe88c2e06', 'Remote workspace sync unavailable')
    })
  } else if (result.ok) {
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: 'synced',
      direction: 'push',
      revision: result.snapshot.revision,
      updatedAt: result.snapshot.updatedAt,
      lastSyncedAt: Date.now(),
      message: translate('auto.hooks.useIpcEvents.f8aaf2bde3', 'Workspace uploaded')
    })
  } else {
    store.setRemoteWorkspaceSyncStatus(targetId, {
      phase: result.reason === 'stale-revision' ? 'conflict' : 'offline',
      direction: 'push',
      revision: result.snapshot?.revision,
      updatedAt: result.snapshot?.updatedAt,
      lastSyncedAt: Date.now(),
      message:
        result.message ??
        (result.reason === 'stale-revision'
          ? translate(
              'auto.hooks.useIpcEvents.workspaceChangedOnAnotherDevice',
              'Workspace changed on another device'
            )
          : translate('auto.hooks.useIpcEvents.2fe88c2e06', 'Remote workspace sync unavailable'))
    })
  }
}

export function createRemoteWorkspaceTargetSync(
  deps: RemoteWorkspaceTargetSyncDeps
): RemoteWorkspaceTargetSync {
  const arrivalByTarget = new Map<string, number>()
  let stopped = false

  const beginArrival = (targetId: string): number => {
    const arrival = (arrivalByTarget.get(targetId) ?? 0) + 1
    arrivalByTarget.set(targetId, arrival)
    return arrival
  }

  const isArrivalCurrent = (targetId: string, arrival: number): boolean =>
    !stopped && arrivalByTarget.get(targetId) === arrival

  const repull = createUnplacedSnapshotRepull({
    isStopped: () => stopped,
    hasCurrentAuthority: (targetId) => deps.getCurrentAuthority(targetId) !== null,
    getSnapshot: (targetId) => deps.remoteWorkspace.get({ targetId }),
    applySnapshot: (targetId, snapshot) => applyPreparedSnapshot(targetId, snapshot),
    reportExhausted: (targetId) => {
      // Why hydrate on exhaustion rather than stay un-hydrated: a path can be unplaceable for good
      // (its worktree was deleted host-side), and an un-hydrated target is filtered out of
      // `hydratedTargetIds` in use-app-session-persistence.ts, so it would never upload again —
      // a permanent regression strictly worse than the tab loss this fix targets. Retries cover the
      // transient degraded-lineage case; past them we settle back to the pre-fix behaviour.
      const store = deps.store.getState()
      const previous = store.remoteWorkspaceSyncStatusByTargetId[targetId]
      store.markRemoteWorkspaceHydrated(targetId)
      store.setRemoteWorkspaceSyncStatus(targetId, {
        phase: 'synced',
        direction: 'pull',
        ...(previous?.revision === undefined ? {} : { revision: previous.revision }),
        ...(previous?.updatedAt === undefined ? {} : { updatedAt: previous.updatedAt }),
        lastSyncedAt: Date.now(),
        message: translate('auto.hooks.useIpcEvents.4f78ba5885', 'Workspace synced')
      })
    }
  })

  const waitForWorkspaceSessionReady = async (): Promise<boolean> => {
    const deadline = Date.now() + WORKSPACE_HYDRATION_TIMEOUT_MS
    while (!stopped && Date.now() < deadline) {
      if (deps.store.getState().workspaceSessionReady) {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return !stopped && deps.store.getState().workspaceSessionReady
  }

  const syncAfterConnect = async (token: DirectSshPreparationToken): Promise<void> => {
    const { authority } = token
    const arrival = beginArrival(authority.targetId)
    const workspaceReady = await waitForWorkspaceSessionReady()
    if (!isArrivalCurrent(authority.targetId, arrival) || !deps.isPreparationTokenCurrent(token)) {
      return
    }
    if (!workspaceReady) {
      deps.store.getState().setRemoteWorkspaceSyncStatus(authority.targetId, {
        phase: 'error',
        direction: 'pull',
        message: translate(
          'auto.hooks.useIpcEvents.88214a785b',
          'Workspace sync waited for local session hydration and timed out'
        )
      })
      return
    }
    const stateBeforeGet = deps.store.getState()
    const worktreeIds = exactTargetWorktreeIds(stateBeforeGet, authority)
    const hasLocalTabs = [...worktreeIds].some(
      (worktreeId) => (stateBeforeGet.tabsByWorktree[worktreeId] ?? []).length > 0
    )
    stateBeforeGet.setRemoteWorkspaceSyncStatus(authority.targetId, {
      phase: 'pulling',
      direction: 'pull'
    })
    const snapshot = await deps.remoteWorkspace.get({ targetId: authority.targetId })
    if (!isArrivalCurrent(authority.targetId, arrival) || !deps.isPreparationTokenCurrent(token)) {
      return
    }
    if (!snapshot) {
      deps.store.getState().setRemoteWorkspaceSyncStatus(authority.targetId, {
        phase: 'offline',
        direction: 'pull',
        message: translate(
          'auto.hooks.useIpcEvents.2fe88c2e06',
          'Remote workspace sync unavailable'
        )
      })
      return
    }
    if (snapshot.revision > 0) {
      const applyToken = buildDirectSshSnapshotApplyToken(token, snapshot.revision)
      if (applyToken) {
        const placement = await applyDirectSshRemoteWorkspaceSnapshot({
          store: deps.store,
          snapshot,
          token: applyToken,
          arrival,
          isArrivalCurrent,
          isPreparationTokenCurrent: deps.isPreparationTokenCurrent,
          waitForWorkspaceSessionReady,
          finalizeHydratedTerminals: deps.finalizeHydratedTerminals
        })
        repull.schedule(authority.targetId, placement, 0)
      }
      return
    }
    deps.store.getState().markRemoteWorkspaceHydrated(authority.targetId)
    if (!hasLocalTabs) {
      deps.store.getState().setRemoteWorkspaceSyncStatus(authority.targetId, {
        phase: 'idle',
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt,
        message: translate('auto.hooks.useIpcEvents.2ec42e1c52', 'No remote workspace yet')
      })
      return
    }
    if (!deps.isPreparationTokenCurrent(token)) {
      return
    }
    const results = await deps.remoteWorkspace.setForConnectedTargets({
      session: buildWorkspaceSessionPayload(deps.store.getState()),
      hydratedTargetIds: [authority.targetId]
    })
    if (!deps.isPreparationTokenCurrent(token)) {
      return
    }
    const result = results.find((entry) => entry.targetId === authority.targetId)?.result
    applyPatchStatus(deps.store.getState(), authority.targetId, result)
  }

  const applyPreparedSnapshot = async (
    targetId: string,
    snapshot: RemoteWorkspaceSnapshot
  ): Promise<DirectSshSnapshotPlacement> => {
    const arrival = beginArrival(targetId)
    const authority = deps.getCurrentAuthority(targetId)
    if (!authority) {
      return 'not-applied'
    }
    const input = await deps.capturePreparationInput(
      authority,
      'workspace-snapshot',
      snapshot.revision
    )
    if (!input || !isArrivalCurrent(targetId, arrival)) {
      return 'not-applied'
    }
    const prepared = await deps.prepareOnly(input)
    if (!prepared.token || !isArrivalCurrent(targetId, arrival)) {
      return 'not-applied'
    }
    const applyToken = buildDirectSshSnapshotApplyToken(prepared.token, snapshot.revision)
    if (!applyToken) {
      return 'not-applied'
    }
    const placement = await applyDirectSshRemoteWorkspaceSnapshot({
      store: deps.store,
      snapshot,
      token: applyToken,
      arrival,
      isArrivalCurrent,
      isPreparationTokenCurrent: deps.isPreparationTokenCurrent,
      waitForWorkspaceSessionReady,
      finalizeHydratedTerminals: deps.finalizeHydratedTerminals
    })
    return placement
  }

  /** Public entry: a snapshot arriving unsolicited starts its own re-pull chain. */
  const applyUnsolicitedSnapshot = async (
    targetId: string,
    snapshot: RemoteWorkspaceSnapshot
  ): Promise<DirectSshSnapshotPlacement> => {
    const placement = await applyPreparedSnapshot(targetId, snapshot)
    repull.schedule(targetId, placement, 0)
    return placement
  }

  return {
    syncAfterConnect,
    applyUnsolicitedSnapshot,
    stop: () => {
      stopped = true
      arrivalByTarget.clear()
      repull.stop()
    }
  }
}
