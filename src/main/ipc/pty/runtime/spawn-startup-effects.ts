import { markClaudePtySpawned } from '../../../claude-accounts/live-pty-gate'
import { track } from '../../../telemetry/client'
import { getCohortAtEmit } from '../../../telemetry/cohort-classifier'
import {
  agentKindSchema,
  launchSourceSchema,
  requestKindSchema
} from '../../../../shared/telemetry-events'
import { ptyOwnership } from '../provider/ownership-state'
import type { RuntimePtySpawnState } from './spawn-state'

export function commitRuntimeStartupEffects(ctx: RuntimePtySpawnState): void {
  if (ctx.stablePaneOwner) {
    return
  }
  const { id, incarnationId } = ctx.result
  if (
    ctx.result.isReattach &&
    ((ctx.result.deferredStartupStatus !== undefined &&
      ctx.result.deferredStartupStatus !== 'accepted') ||
      ptyOwnership.hasDeferredStartup(id, incarnationId))
  ) {
    return
  }
  const { runtime } = ctx.deps
  const { launchCommand, isClaudeLaunch } = ctx
  const agentKind = agentKindSchema.safeParse(ctx.args.telemetry?.agent_kind)
  const launchSource = launchSourceSchema.safeParse(ctx.args.telemetry?.launch_source)
  const requestKind = requestKindSchema.safeParse(ctx.args.telemetry?.request_kind)
  const onAccepted = (): void => {
    runtime?.noteTerminalSpawnCommand?.(id, launchCommand ?? null)
    if (isClaudeLaunch) {
      markClaudePtySpawned(id)
    }
    if (agentKind.success && launchSource.success && requestKind.success) {
      track('agent_started', {
        agent_kind: agentKind.data,
        launch_source: launchSource.data,
        request_kind: requestKind.data,
        ...getCohortAtEmit()
      })
    }
  }
  const operationId = ctx.args.deferredStartupOperationId
  ptyOwnership.clearDeferredStartup(id)
  if (operationId !== undefined) {
    if (incarnationId) {
      ptyOwnership.deferStartup(id, { incarnationId, operationId, isClaudeLaunch, onAccepted })
    }
    return
  }
  onAccepted()
}
