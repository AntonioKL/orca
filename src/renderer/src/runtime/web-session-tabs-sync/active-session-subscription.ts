import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { isRuntimeSubscriptionReplayResponse } from '../../../../shared/runtime-subscription-replay'
import { useAppStore } from '../../store'
import { getRuntimeEnvironmentRevision } from '../runtime-environment-revision'
import { recoverWebSessionTerminalOrphansBeforeApply } from '../web-session-terminal-orphan-recovery'
import { installWindowVisibilitySubscriptionParking } from '../window-visibility-subscription-parking'
import {
  beginWebSessionTabsSnapshotRecovery,
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './tracking'
import {
  decideWebSessionTabsSnapshot,
  shouldBootstrapInitialWebRuntimeTerminal,
  shouldRespawnWebRuntimeTerminalAfterWake,
  shouldSyncRuntimeSessionTabs
} from './tracking-decisions'
import {
  acceptReplayedWebSessionTabsSnapshot,
  getWebSessionTabsTrackingGeneration
} from './tracking-lifecycle'
import { applyWebSessionTabsSnapshot } from './snapshot-api'
import { applyWebSessionTabsStorePatch } from './store-patch'
import {
  hostSessionMirrorSettleForPatchlessFrame,
  type HostSessionMirrorSettle
} from './mirror-settle'
import {
  beginWebRuntimeWakeTerminalRespawn,
  endWebRuntimeWakeTerminalRespawn,
  shouldSkipWebRuntimeWakeTerminalRespawn
} from '../web-runtime-wake-terminal-respawn'
import { createWebRuntimeSessionTerminal } from '../web-runtime-session'
import { toRuntimeWorktreeSelector } from '../runtime-worktree-selector'
import type { SessionTabsStreamEvent } from './state'

type Ref<T> = { current: T }

export type ActiveSubscriptionArgs = {
  activeWorktreeId: string | null
  activeWorktreeRuntimeEnvironmentId: string | null | undefined
  activeWorktreeRuntimeConnectionGeneration: number
  activeWorktreeRuntimePairingRevision: number | undefined
  workspaceSessionReady: boolean
  visibilitySnapshotReceipt: Ref<
    (environmentId: string, snapshot: RuntimeMobileSessionTabsResult, receivedFrame: number) => void
  >
  visibilitySnapshotAccepted: Ref<
    (environmentId: string, snapshot: RuntimeMobileSessionTabsResult, receivedFrame: number) => void
  >
  visibilitySnapshotApply: Ref<
    (
      environmentId: string,
      snapshot: RuntimeMobileSessionTabsResult,
      receivedFrame: number
    ) => boolean
  >
}

/** Install the selected-worktree stream, which resumes immediately on visibility changes. */
export function installActiveSessionTabsSubscription({
  activeWorktreeId,
  activeWorktreeRuntimeEnvironmentId,
  activeWorktreeRuntimeConnectionGeneration,
  activeWorktreeRuntimePairingRevision,
  workspaceSessionReady,
  visibilitySnapshotReceipt,
  visibilitySnapshotAccepted,
  visibilitySnapshotApply
}: ActiveSubscriptionArgs): (() => void) | undefined {
  const environmentId = activeWorktreeRuntimeEnvironmentId?.trim()
  if (
    !shouldSyncRuntimeSessionTabs({
      activeWorktreeId,
      activeWorktreeRuntimeEnvironmentId,
      workspaceSessionReady
    }) ||
    !environmentId ||
    !activeWorktreeId
  ) {
    return undefined
  }
  const expectedTrackingGeneration = getWebSessionTabsTrackingGeneration(environmentId)
  let requestedInitialTerminal = false
  let requestedRespawnAfterWake = false

  const applyActiveSnapshot = async (
    event: RuntimeMobileSessionTabsResult & { type: 'snapshot' | 'updated' },
    response: RuntimeRpcResponse<unknown>,
    isCurrent: () => boolean,
    receivedFrame: number
  ): Promise<HostSessionMirrorSettle | null> => {
    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      useAppStore.getState(),
      event,
      environmentId
    )
    if (
      !isCurrent() ||
      !recovered ||
      !shouldApplyRecoveredWebSessionTabsSnapshot(environmentId, recovered, receivedFrame) ||
      !visibilitySnapshotApply.current(environmentId, recovered, receivedFrame)
    ) {
      return null
    }
    if (event.type === 'snapshot' || isRuntimeSubscriptionReplayResponse(response)) {
      acceptReplayedWebSessionTabsSnapshot(environmentId, recovered.worktree)
    }
    const recoveredEvent: SessionTabsStreamEvent = { ...recovered, type: event.type }
    const decision = decideWebSessionTabsSnapshot(recovered, environmentId)
    const syncState = useAppStore.getState()
    const localTabs = syncState.tabsByWorktree[activeWorktreeId] ?? []
    const localTerminalCount = localTabs.length
    const hasLiveLocalPty = localTabs.some(
      (tab) => (syncState.ptyIdsByTabId[tab.id] ?? []).length > 0
    )
    const bootstrap = shouldBootstrapInitialWebRuntimeTerminal({
      event: recoveredEvent,
      activeWorktreeId,
      requestedInitialTerminal,
      snapshotIsFresh: decision.apply,
      localTerminalCount
    })
    const respawn = shouldRespawnWebRuntimeTerminalAfterWake({
      event: recoveredEvent,
      activeWorktreeId,
      requestedRespawnAfterWake,
      snapshotIsFresh: decision.apply,
      localTerminalCount,
      hasLiveLocalPty,
      skipWakeRespawn: shouldSkipWebRuntimeWakeTerminalRespawn(activeWorktreeId)
    })
    let settle: HostSessionMirrorSettle | null = decision.apply
      ? null
      : hostSessionMirrorSettleForPatchlessFrame(decision, environmentId, recovered.worktree, {
          connectionGeneration: activeWorktreeRuntimeConnectionGeneration,
          pairingRevision: activeWorktreeRuntimePairingRevision,
          trackingGeneration: expectedTrackingGeneration
        })
    if (decision.apply) {
      const replayed = isRuntimeSubscriptionReplayResponse(response)
      settle = applyWebSessionTabsStorePatch(
        (state) => applyWebSessionTabsSnapshot(state, recovered, environmentId),
        {
          frames: [
            {
              environmentId,
              worktreeId: recovered.worktree,
              decision,
              expectedEnvironmentConnectionGeneration: activeWorktreeRuntimeConnectionGeneration,
              expectedEnvironmentPairingRevision: activeWorktreeRuntimePairingRevision,
              expectedTrackingGeneration
            }
          ]
        },
        recovered,
        event.type === 'updated' && !replayed
      )
      visibilitySnapshotAccepted.current(environmentId, recovered, receivedFrame)
    }
    try {
      if (isCurrent() && bootstrap) {
        requestedInitialTerminal = true
        await createWebRuntimeSessionTerminal({
          worktreeId: activeWorktreeId,
          environmentId,
          activate: true
        })
      } else if (isCurrent() && respawn && beginWebRuntimeWakeTerminalRespawn(activeWorktreeId)) {
        requestedRespawnAfterWake = true
        await createWebRuntimeSessionTerminal({
          worktreeId: activeWorktreeId,
          environmentId,
          activate: true,
          selectWorktree: false
        }).finally(() => endWebRuntimeWakeTerminalRespawn(activeWorktreeId))
      }
    } catch (error) {
      if (isCurrent()) {
        console.warn('[web-session-tabs-sync] snapshot follow-up failed:', error)
      }
    }
    return settle
  }

  return installWindowVisibilitySubscriptionParking([
    {
      subscribe: (isCurrent) =>
        window.api.runtimeEnvironments.subscribe(
          {
            selector: environmentId,
            method: 'session.tabs.subscribe',
            params: { worktree: toRuntimeWorktreeSelector(activeWorktreeId) },
            timeoutMs: 15_000,
            expectedEnvironmentPairingRevision: activeWorktreeRuntimePairingRevision
          },
          {
            onResponse: (response) => {
              if (
                !isCurrent() ||
                getRuntimeEnvironmentRevision(environmentId) !==
                  activeWorktreeRuntimePairingRevision
              ) {
                return
              }
              if (response.ok === false) {
                console.warn('[web-session-tabs-sync] subscription failed:', response.error.message)
                return
              }
              const event = response.result as SessionTabsStreamEvent
              if (event.type !== 'snapshot' && event.type !== 'updated') {
                return
              }
              const frame = recordReceivedWebSessionTabsSnapshot(environmentId, event)
              visibilitySnapshotReceipt.current(environmentId, event, frame)
              const finish = beginWebSessionTabsSnapshotRecovery(
                environmentId,
                event.worktree,
                frame
              )
              void applyActiveSnapshot(event, response, isCurrent, frame)
                .catch((error) => {
                  if (isCurrent()) {
                    console.warn('[web-session-tabs-sync] active snapshot recovery failed:', error)
                  }
                  return null
                })
                .then((settle) => {
                  finish()
                  if (isCurrent()) {
                    settle?.()
                  }
                })
            },
            onError: (error) => {
              if (isCurrent()) {
                console.warn('[web-session-tabs-sync] subscription error:', error.message)
              }
            }
          }
        ),
      onSubscribeError: (error) => {
        console.warn(
          '[web-session-tabs-sync] failed to subscribe:',
          error instanceof Error ? error.message : String(error)
        )
      },
      onUnsubscribeError: (error) => {
        console.warn('[web-session-tabs-sync] failed to unsubscribe:', error)
      }
    }
  ])
}
