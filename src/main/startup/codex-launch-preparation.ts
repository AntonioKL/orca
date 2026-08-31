import { app } from 'electron'
import type { CodexHomeLaunchContext } from '../ipc/pty'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import { markCodexProjectTrusted } from '../agent-trust-presets'
import { codexHookService } from '../codex/hook-service'
import { getDefaultWslDistro } from '../wsl'
import { isAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import { ensureRealHomeCodexHookState } from '../codex/codex-real-home-hook-install'
import { mainProcessState as state } from './main-process-state'

export async function prepareCodexRuntimeHomeForLaunch(
  target?: CodexAccountSelectionTarget,
  launchEnv?: NodeJS.ProcessEnv,
  launchContext?: CodexHomeLaunchContext
): Promise<string | null> {
  const runtimeHome = state.codexRuntimeHome
  if (!runtimeHome) {
    throw new Error('Codex runtime home service is not initialized')
  }
  if (
    target?.runtime !== 'wsl' &&
    launchContext?.launchAgent === 'codex' &&
    launchContext.workspacePath
  ) {
    try {
      await markCodexProjectTrusted(launchContext.workspacePath)
    } catch (error) {
      console.warn('[codex-project-trust] failed to pre-mark launch workspace:', error)
    }
  }
  const ensureRealHomeHooksIfSelected = async (): Promise<boolean> => {
    if (target?.runtime === 'wsl' || !runtimeHome.isHostSystemDefaultRealHomeSelected(launchEnv)) {
      return false
    }
    await ensureRealHomeCodexHookState({
      hooksEnabled: isAgentStatusHooksEnabled(state.store?.getSettings()),
      userDataPath: app.getPath('userData')
    })
    return true
  }
  let realHomeHooksPrepared = await ensureRealHomeHooksIfSelected()
  let runtimeHomePath = runtimeHome.prepareForCodexLaunch(target, launchEnv, {
    unavailableManagedHomePath: launchContext?.unavailableManagedHomePath
  })
  if (runtimeHomePath === null && !realHomeHooksPrepared) {
    realHomeHooksPrepared = await ensureRealHomeHooksIfSelected()
    if (realHomeHooksPrepared) {
      runtimeHomePath = runtimeHome.prepareForCodexLaunch(target, launchEnv, {
        unavailableManagedHomePath: launchContext?.unavailableManagedHomePath
      })
    }
  }
  if (runtimeHomePath === null && target?.runtime !== 'wsl') {
    return null
  }
  const hookTarget =
    target?.runtime === 'wsl'
      ? { runtime: 'wsl' as const, wslDistro: target.wslDistro?.trim() || getDefaultWslDistro() }
      : target
  const hooksEnabled = isAgentStatusHooksEnabled(state.store?.getSettings())
  try {
    const status = hooksEnabled
      ? ((await codexHookService.installForRuntimeHome(runtimeHomePath, hookTarget)) ??
        (await codexHookService.install(runtimeHomePath ?? undefined)))
      : (codexHookService.refreshRuntimeUserHooksForRuntimeHome(runtimeHomePath, hookTarget) ??
        (await codexHookService.refreshRuntimeUserHooks(runtimeHomePath ?? undefined)))
    if (status.state === 'error') {
      console.warn(
        `[codex-hook-service] failed to ${hooksEnabled ? 'refresh' : 'refresh user'} runtime hooks before launch`,
        status.detail
      )
    }
  } catch (error) {
    console.warn(
      `[codex-hook-service] failed to ${hooksEnabled ? 'refresh' : 'refresh user'} runtime hooks before launch`,
      error
    )
  }
  return runtimeHomePath
}
