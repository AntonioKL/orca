import { makePaneKey } from '../../../../shared/stable-pane-id'
import { rememberPaneKeyBindingForPty } from '../pane/key-state'
import type { RuntimePtySpawnState } from './spawn-state'

type RuntimePaneKeyContext = Pick<
  RuntimePtySpawnState,
  'result' | 'spawnIdentityPaneKey' | 'metadataPaneKey' | 'sourcePaneKey'
>

export function rememberRuntimeSpawnPaneKey(ctx: RuntimePaneKeyContext): string | null {
  return rememberPaneKeyBindingForPty(
    ctx.result.id,
    ctx.spawnIdentityPaneKey ?? ctx.metadataPaneKey ?? ctx.sourcePaneKey,
    ctx.result.isReattach === true ? ctx.sourcePaneKey : undefined
  )
}

export function rememberRuntimeSurfacePaneKey(
  ctx: Pick<RuntimePtySpawnState, 'result' | 'sourcePaneKey'>,
  surface: { tabId: string; leafId: string }
): void {
  rememberPaneKeyBindingForPty(
    ctx.result.id,
    makePaneKey(surface.tabId, surface.leafId),
    ctx.sourcePaneKey
  )
}
