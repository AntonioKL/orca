#!/usr/bin/env node

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { startCdpServer } from 'inspect-webkit'
import { resolveEmulatorOrcaCli } from './emulator-orca-cli-selection.mjs'
import { stopHostedChildProcess } from './hosted-child-process-shutdown.mjs'
import { findAvailableHostedLoopbackPort } from './hosted-loopback-port.mjs'
import { probeHostedIosAppBoundNavigation } from './hosted-ios-app-bound-navigation-probe.mjs'
import { startHostedIosEmulatorController } from './hosted-ios-emulator-controller.mjs'
import { openHostedIosHybridRoute } from './hosted-ios-hybrid-route-handoff.mjs'
import {
  startHostedIosMobileLauncher,
  waitForHostedIosMobileLauncher
} from './hosted-ios-mobile-launcher.mjs'
import { completeHostedIosNativeOnboarding } from './hosted-ios-native-onboarding.mjs'
import { hostedIosSimulatorAppPreparation } from './hosted-ios-simulator-app-preparation.mjs'
import {
  bootHostedIosSimulator,
  resolveHostedIosSimulatorUdid
} from './hosted-ios-simulator-device.mjs'
import { probeHostedIosUserGestureWindow } from './hosted-ios-user-gesture-window-probe.mjs'
import { waitForVisibleHostedWebView } from './hosted-webview-cdp-session.mjs'
import { resolveHostedWebViewRuntimeDirectory } from './hosted-webview-runtime-directory.mjs'

const worktree = path.resolve(import.meta.dirname, '../..')
const options = parseOptions(process.argv.slice(2))
const runtimeDirectory = resolveHostedWebViewRuntimeDirectory({
  worktree,
  override: process.env.ORCA_E2E_MOBILE_WEBVIEW_RUN_DIRECTORY
})
const orcaSelection = resolveEmulatorOrcaCli({
  explicitCommand: process.env.ORCA_CLI,
  managedCommand: process.env.ORCA_CLI_COMMAND,
  devRepoRoot: process.env.ORCA_DEV_REPO_ROOT,
  worktree,
  cwd: worktree
})

function parseOptions(args) {
  const parsed = {
    device: 'iPhone 17 Pro',
    gestureOnly: false,
    reuseNativeInstall: false,
    skipNativeBuild: false,
    timeoutMs: 180_000
  }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--device' && args[index + 1]) {
      parsed.device = args[++index]
    } else if (args[index] === '--timeout-ms' && args[index + 1]) {
      parsed.timeoutMs = Number(args[++index])
    } else if (args[index] === '--skip-native-build') {
      parsed.skipNativeBuild = true
    } else if (args[index] === '--reuse-native-install') {
      parsed.reuseNativeInstall = true
    } else if (args[index] === '--gesture-only') {
      parsed.gestureOnly = true
    } else {
      throw new Error(`Unknown argument: ${args[index]}`)
    }
  }
  return parsed
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('Hosted iOS WebView probes require macOS and Xcode.')
  }
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 })
  const deviceUdid = await resolveHostedIosSimulatorUdid(options.device)
  let launcher = null
  let inspector = null
  let emulatorController = null
  try {
    await bootHostedIosSimulator(deviceUdid)
    emulatorController = await startHostedIosEmulatorController({
      orcaCli: orcaSelection.command,
      runtimeDirectory,
      worktree
    })
    const appPreparation = hostedIosSimulatorAppPreparation({ deviceUdid, worktree, ...options })
    const nativeAppPath = await appPreparation.run()
    launcher = startHostedIosMobileLauncher({
      deviceUdid,
      emulatorControlUserDataPath: emulatorController.userData,
      orcaCli: orcaSelection.command,
      runtimeDirectory,
      worktree
    })
    await waitForHostedIosMobileLauncher(launcher, options.timeoutMs)
    const emulator = {
      deviceUdid,
      orcaCli: orcaSelection.command,
      userDataDir: emulatorController.userData,
      worktree
    }
    const inspectorPort = await findAvailableHostedLoopbackPort()
    const discoveryUrl = `http://127.0.0.1:${inspectorPort}`
    inspector = await startCdpServer({ port: inspectorPort })
    const expectedWorkspace = path.basename(worktree)
    await completeHostedIosNativeOnboarding(emulator, expectedWorkspace, options.timeoutMs)
    await openHostedIosHybridRoute(emulator, options.timeoutMs)
    const workspaceDocument = await waitForVisibleHostedWebView({
      discoveryUrl,
      expectedText: expectedWorkspace,
      timeoutMs: options.timeoutMs
    })
    const gesture = await probeHostedIosUserGestureWindow({
      discoveryUrl,
      emulator,
      expectedWorkspace,
      timeoutMs: options.timeoutMs,
      workspaceDocument
    })
    const appBound = options.gestureOnly
      ? null
      : await probeHostedIosAppBoundNavigation({
          deviceUdid,
          emulator,
          sessionDocument: gesture.sessionDocument,
          timeoutMs: options.timeoutMs
        })
    const { sessionDocument: _session, ...gestureEvidence } = gesture
    console.log(JSON.stringify({ appBound, gesture: gestureEvidence, nativeAppPath }, null, 2))
  } finally {
    inspector?.stop()
    await stopHostedChildProcess(launcher)
    await emulatorController?.stop()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
})
