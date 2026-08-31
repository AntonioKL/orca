import { app, ipcMain, powerMonitor, session } from 'electron'
import { is } from '@electron-toolkit/utils'
import os from 'node:os'
import { join } from 'node:path'
import { maybeRedirectAppImageCliLaunch } from './appimage-cli-redirect'
import { maybeRedirectPackagedCliEntryLaunch } from './packaged-cli-entry-redirect'
import { argvRequestsServeMode, normalizeServeModeArgv } from './serve-mode-argv'
import {
  configureDevUserDataPath,
  configureElectronNetworkCompatibility,
  configureOrcaUserDataPathEnv,
  disableUnsupportedChromiumFeatures,
  enableMainProcessGpuFeatures,
  installDevParentDisconnectQuit,
  installDevParentSignalQuit,
  installDevParentWatchdog,
  patchPackagedProcessPath,
  optOutOfHiddenPageWakeUpThrottling
} from './configure-process'
import { installServeSupervisorDisconnectQuit } from '../serve-update-handoff'
import {
  installUncaughtPipeErrorGuard,
  installUnhandledRejectionLogging
} from './main-process-error-guards'
import { hydrateShellPath, mergePathSegments } from './hydrate-shell-path'
import { configureRemoteServerUpdater } from '../runtime/remote-server-updater'
import {
  getRemoteServerUpdaterSnapshot,
  checkForRemoteServerUpdate,
  downloadRemoteServerUpdate,
  installRemoteServerUpdate,
  isQuittingForUpdate
} from '../updater'
import { getDevInstanceIdentity, shouldApplyPreReadyAppName } from './dev-instance-identity'
import { enableRendererHeapHeadroom } from './renderer-heap-headroom'
import { isStartupDiagnosticsEnabled, logStartupDiagnostic } from './startup-diagnostics'
import { startEventLoopStallProbe } from './event-loop-stall-probe'
import { startMainThreadChurnProbe } from '../diagnostics/main-thread-churn-probe'
import { settledDiffCache } from '../git/source-control/git-read-cache-invalidation'
import { reserveServeStdoutForReadiness } from '../server/serve-stdout-boundary'
import { createServeDesktopActivationGate } from './serve-desktop-activation'
import {
  shouldBypassSingleInstanceLock,
  shouldSkipSingleInstanceLock,
  acquireSingleInstanceLock,
  logSingleInstanceLockBypass,
  logSingleInstanceLockFailure,
  SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE
} from './single-instance-lock'
import { setAppEnvironment } from '../../shared/app-environment'
import { ElectronAppEnvironment } from '../host/electron-app-environment'
import { setSecretStore } from '../../shared/secret-store'
import { ElectronSecretStore } from '../host/electron-secret-store'
import { setPtyHostBindings } from '../ipc/pty-host-bindings'
import { electronRuntimeDesktopSurface } from '../host/electron-runtime-desktop-surface'
import { setRuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'
import { electronRuntimeBrowserCommandsFactory } from '../host/electron-browser-commands'
import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import { electronHttpClient } from '../host/electron-http-client'
import { setMainHttpClient } from '../network/http-client'
import { electronSpeechServiceFactories } from '../host/electron-speech-services'
import { setSpeechServiceFactories } from '../speech/speech-runtime-service'
import { setWorktreeWatcherRemoval } from '../ipc/worktree-watcher-removal'
import { desktopWorktreeWatcherRemoval } from '../ipc/filesystem-watcher'
import { setDefaultProxySessionResolver } from '../network/proxy-settings'
import { initDataPath, getCanonicalUserDataPath } from '../persistence'
import { applyMacPressAndHoldDefaultAtStartup } from '../macos-press-and-hold-default'
import { initSessionParseCachePersistence } from '../ai-vault/session-parse-cache-persistence'
import { initOrcaProfilePaths } from '../orca-profiles/profile-index-store'
import { initStatsPath } from '../stats/collector'
import { initClaudeUsagePath } from '../claude-usage/store'
import { initCodexUsagePath } from '../codex-usage/store'
import { initOpenCodeUsagePath } from '../opencode-usage/store'
import { registerDocPreviewSchemePrivileges } from '../browser/doc-preview-protocol'
import { startCrashpadCapture } from '../crash-reporting/crashpad-capture'
import { CrashReportStore } from '../crash-reporting/crash-report-store'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { GpuCrashDiagnosticsRecorder } from '../crash-reporting/gpu-crash-diagnostics'
import { getMainProcessLifecycleIdentity } from '../crash-reporting/main-process-lifecycle-identity'
import { ensureVirtualDisplayForHeadlessServe } from './ensure-virtual-display'
import { maybeApplyGpuFallbackForThisLaunch, registerGpuLifecycleHandlers } from './gpu-lifecycle'
import { mainProcessState as state } from './main-process-state'
import { initializeSyntheticTitleRuntime } from './synthetic-title-runtime'

export type MainProcessPreflightOptions = {
  focusExistingWindow: () => void
  requestDesktopActivation: (argv?: readonly string[]) => void
}

/** Performs all module-scope work that must happen before Electron's ready event. */
export function runMainProcessPreflight(options: MainProcessPreflightOptions): boolean {
  const packagedRedirect = maybeRedirectPackagedCliEntryLaunch({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath
  })
  if (packagedRedirect.redirected) {
    app.exit(packagedRedirect.status)
  }
  const appImageRedirect = maybeRedirectAppImageCliLaunch({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath
  })
  if (appImageRedirect.redirected) {
    app.exit(appImageRedirect.status)
  }
  if (argvRequestsServeMode(process.argv)) {
    process.argv = normalizeServeModeArgv(process.argv)
  }
  state.isServeMode = process.argv.includes('--serve')
  if (state.isServeMode) {
    reserveServeStdoutForReadiness()
  }
  state.devInstanceIdentity = getDevInstanceIdentity(is.dev)
  state.devAgentHookEndpointNamespace = state.devInstanceIdentity.isDev
    ? state.devInstanceIdentity.appUserModelId
    : undefined
  state.desktopActivationGate = createServeDesktopActivationGate({
    initialState: state.isServeMode ? 'initializing' : 'ready',
    activateWindow: () => {
      if (!isQuittingForUpdate()) {
        options.focusExistingWindow()
      }
    },
    onBlocked: (reason) => console.error(`[serve] Desktop activation blocked: ${reason}`)
  })
  installUncaughtPipeErrorGuard()
  installUnhandledRejectionLogging()
  process.env.ORCA_APP_VERSION = app.getVersion()
  configureRemoteServerUpdater({
    getSnapshot: getRemoteServerUpdaterSnapshot,
    check: checkForRemoteServerUpdate,
    download: downloadRemoteServerUpdate,
    install: installRemoteServerUpdate
  })
  patchPackagedProcessPath()
  if (app.isPackaged && process.platform !== 'win32') {
    void hydrateShellPath().then((result) => {
      if (result.ok) {
        mergePathSegments(result.segments)
      } else {
        console.warn(
          `[shell-path] login-shell probe failed (${result.failureReason}); using seeded PATH`
        )
      }
    })
  }
  const isDev = is.dev
  configureDevUserDataPath(isDev)
  configureOrcaUserDataPathEnv()
  installServeSupervisorDisconnectQuit(state.isServeMode)
  state.startupDiagnosticsEnabled = isStartupDiagnosticsEnabled()
  if (state.startupDiagnosticsEnabled) {
    logStartupDiagnostic('before-single-instance-lock', {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      osRelease: os.release(),
      userData: app.getPath('userData'),
      e2eUserData: Boolean(process.env.ORCA_E2E_USER_DATA_DIR)
    })
    startEventLoopStallProbe()
  }
  startMainThreadChurnProbe({ extraStats: () => ({ diffCache: settledDiffCache.stats() }) })
  const bypass = shouldBypassSingleInstanceLock({ isDev, isServeMode: state.isServeMode })
  const skip = shouldSkipSingleInstanceLock({ isDev, isServeMode: state.isServeMode })
  if (bypass) {
    logSingleInstanceLockBypass()
  }
  const hasLock = skip || bypass || acquireSingleInstanceLock(app, options.requestDesktopActivation)
  if (state.startupDiagnosticsEnabled) {
    logStartupDiagnostic('single-instance-lock-result', {
      acquired: hasLock,
      bypassed: bypass,
      skippedForDev: skip
    })
  }
  if (!hasLock) {
    logSingleInstanceLockFailure()
    app.exit(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)
    return false
  }
  setAppEnvironment(new ElectronAppEnvironment())
  setSecretStore(new ElectronSecretStore())
  setPtyHostBindings({ ipc: ipcMain, power: powerMonitor })
  setRuntimeDesktopSurface(electronRuntimeDesktopSurface)
  setRuntimeBrowserCommandsFactory(electronRuntimeBrowserCommandsFactory)
  setDefaultProxySessionResolver(() => session.defaultSession)
  setMainHttpClient(electronHttpClient)
  setSpeechServiceFactories(electronSpeechServiceFactories)
  setWorktreeWatcherRemoval(desktopWorktreeWatcherRemoval)
  const shouldCoupleToDevParent = isDev && !state.isServeMode
  installDevParentDisconnectQuit(shouldCoupleToDevParent)
  installDevParentWatchdog(shouldCoupleToDevParent)
  installDevParentSignalQuit(shouldCoupleToDevParent)
  initDataPath()
  applyMacPressAndHoldDefaultAtStartup(getCanonicalUserDataPath())
  initSessionParseCachePersistence({
    filePath: join(getCanonicalUserDataPath(), 'ai-vault', 'session-parse-cache.json'),
    appVersion: app.getVersion()
  })
  initOrcaProfilePaths()
  initStatsPath()
  initClaudeUsagePath()
  initCodexUsagePath()
  initOpenCodeUsagePath()
  if (state.devInstanceIdentity && shouldApplyPreReadyAppName(state.devInstanceIdentity)) {
    app.setName(state.devInstanceIdentity.appName)
  }
  registerDocPreviewSchemePrivileges()
  startCrashpadCapture()
  state.crashReports = CrashReportStore.fromUserData()
  state.gpuCrashDiagnostics =
    process.platform === 'win32'
      ? new GpuCrashDiagnosticsRecorder({
          provider: {
            getGPUInfo: (infoType) => app.getGPUInfo(infoType),
            getGPUFeatureStatus: () => app.getGPUFeatureStatus()
          },
          recordBreadcrumb: (data) => recordDurableCrashBreadcrumb('gpu_crash_hardware', data)
        })
      : null
  recordCrashBreadcrumb('app_started', {
    packaged: app.isPackaged,
    platform: process.platform,
    ...getMainProcessLifecycleIdentity()
  })
  disableUnsupportedChromiumFeatures()
  optOutOfHiddenPageWakeUpThrottling()
  configureElectronNetworkCompatibility()
  enableRendererHeapHeadroom()
  maybeApplyGpuFallbackForThisLaunch()
  if (!state.gpuFallbackActiveThisLaunch) {
    enableMainProcessGpuFeatures()
  }
  state.headlessBrowserDisplayAvailable = ensureVirtualDisplayForHeadlessServe({
    isServeMode: state.isServeMode
  })
  initializeSyntheticTitleRuntime()
  registerGpuLifecycleHandlers()
  return true
}
