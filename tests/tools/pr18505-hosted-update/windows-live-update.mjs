import { chromium } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  seedFreshProfile,
  buildFreshProfile,
  createSeededRepo
} from '../win-update-e2e/onboarding-profile.mjs'
import { silentInstall } from '../win-update-e2e/installer-steps.mjs'
import { runScriptFileJson } from '../win-update-e2e/powershell-runner.mjs'
import {
  captureOptionalSettingsSurface,
  createInstallLifecycleRecorder,
  sendRuntimeRequest,
  startInstallFileTimeline
} from './windows-update-evidence.mjs'

// Shared by disposable Windows NSIS and macOS ShipIt jobs; source is an installer or app executable respectively.

const [sourceInstaller, finalTag, finalVersion, higherTag, higherVersion, outputDirArg] =
  process.argv.slice(2)
if (
  !sourceInstaller ||
  !finalTag ||
  !finalVersion ||
  !higherTag ||
  !higherVersion ||
  !outputDirArg
) {
  throw new Error(
    'usage: windows-live-update.mjs <source-installer> <final-tag> <final-version> <higher-tag> <higher-version> <output-dir>'
  )
}

const outputDir = path.resolve(outputDirArg)
mkdirSync(outputDir, { recursive: true })
if (process.platform !== 'win32' && process.platform !== 'darwin') {
  throw new Error(`packaged in-app updater harness does not support ${process.platform}`)
}
const profileDir = path.join(outputDir, 'profile')
const isolatedHome = path.join(profileDir, 'home')
mkdirSync(isolatedHome, { recursive: true })
const freshProfile = buildFreshProfile({
  repo: createSeededRepo(path.join(profileDir, 'fixture-repo'))
})
freshProfile.ui = { lastUpdateCheckAt: Date.now() }
seedFreshProfile(profileDir, freshProfile)

const exePath =
  process.platform === 'win32'
    ? silentInstall(path.resolve(sourceInstaller)).exePath
    : path.resolve(sourceInstaller)
const cliPath =
  process.platform === 'win32'
    ? path.join(path.dirname(exePath), 'resources', 'bin', 'orca.exe')
    : path.resolve(path.dirname(exePath), '..', 'Resources', 'bin', 'orca')
if (!existsSync(cliPath)) {
  throw new Error(`packaged CLI missing: ${cliPath}`)
}

const appEnv = {
  ...process.env,
  ORCA_E2E_USER_DATA_DIR: profileDir,
  ORCA_E2E_HOME_DIR: isolatedHome,
  ORCA_USER_DATA_PATH: profileDir,
  ORCA_BACKGROUND_LAUNCH: '1',
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  ELECTRON_ENABLE_LOGGING: '1'
}
delete appEnv.ELECTRON_RUN_AS_NODE

const appLog = path.join(outputDir, 'app.log')
const appOut = await import('node:fs').then(({ openSync }) => openSync(appLog, 'a'))
const runtimePath = path.join(profileDir, 'orca-runtime.json')
const ownedPids = new Set()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const trafficMode = process.env.ORCA_QA_TRAFFIC_MODE ?? 'continuous'
if (!['continuous', 'until-old-exit', 'none'].includes(trafficMode)) {
  throw new Error(`invalid ORCA_QA_TRAFFIC_MODE: ${trafficMode}`)
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function stopOwnedPids() {
  for (const pid of ownedPids) {
    if (!isPidAlive(pid)) {
      continue
    }
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
}
process.once('exit', stopOwnedPids)

async function waitFor(predicate, timeoutMs, label, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await predicate()
      if (last) {
        return last
      }
    } catch (error) {
      last = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`timeout waiting for ${label}; last=${String(last)}`)
}

async function waitForRuntime(excludedRuntimeIds, label) {
  return waitFor(
    () => {
      if (!existsSync(runtimePath)) {
        return false
      }
      const value = JSON.parse(readFileSync(runtimePath, 'utf8'))
      if (!Number.isInteger(value.pid) || value.pid <= 0 || typeof value.runtimeId !== 'string') {
        return false
      }
      if (excludedRuntimeIds.has(value.runtimeId) || !isPidAlive(value.pid)) {
        return false
      }
      return value
    },
    300_000,
    label,
    1_000
  )
}

async function waitForCdpPage() {
  await waitFor(
    async () => {
      const response = await fetch('http://127.0.0.1:9333/json')
      const targets = await response.json()
      return targets.some((target) => target.type === 'page')
    },
    120_000,
    'CDP page'
  )
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
  const page = await waitFor(
    async () => {
      return browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => {
          try {
            return new URL(candidate.url()).pathname.endsWith('/index.html')
          } catch {
            return false
          }
        })
    },
    60_000,
    'Orca renderer page'
  )
  await page.waitForLoadState('domcontentloaded')
  await waitFor(
    () =>
      page
        .evaluate(() => window.api.updater.getVersion())
        .then((version) => (typeof version === 'string' && version.length > 0 ? version : false)),
    120_000,
    'packaged updater renderer bridge'
  )
  return { browser, page }
}

async function launchDriven(label, excludedRuntimeIds) {
  await waitFor(
    async () => {
      try {
        await fetch('http://127.0.0.1:9333/json')
        return false
      } catch {
        return true
      }
    },
    30_000,
    'previous CDP listener exit'
  )

  const launcher = spawn(exePath, ['--remote-debugging-port=9333'], {
    env: appEnv,
    stdio: ['ignore', appOut, appOut]
  })
  if (!launcher.pid) {
    throw new Error(`${label} packaged app launch returned no PID`)
  }
  ownedPids.add(launcher.pid)
  launcher.once('exit', () => ownedPids.delete(launcher.pid))
  writeFileSync(path.join(outputDir, `${label}-launcher-pid.txt`), `${launcher.pid}\n`)

  const [{ browser, page }, runtime] = await Promise.all([
    waitForCdpPage(),
    waitForRuntime(excludedRuntimeIds, `${label} authoritative runtime`)
  ])
  await waitFor(() => hasVisibleWindow(runtime.pid), 60_000, `${label} visible top-level window`)
  const settingsVisible = await captureOptionalSettingsSurface(page, outputDir, label)
  ownedPids.add(runtime.pid)
  writeFileSync(path.join(outputDir, `${label}-pid.txt`), `${runtime.pid}\n`)
  return { browser, page, runtime, settingsVisible }
}

async function terminateExactRuntime(session, label) {
  const disconnected = session.browser?.isConnected()
    ? new Promise((resolve) => session.browser.once('disconnected', resolve))
    : Promise.resolve()
  if (isPidAlive(session.runtime.pid)) {
    process.kill(session.runtime.pid, 'SIGTERM')
  }
  await waitFor(() => !isPidAlive(session.runtime.pid), 30_000, `${label} exact PID exit`)
  ownedPids.delete(session.runtime.pid)
  await Promise.race([disconnected, sleep(10_000)])
}

function readVisibleWindows() {
  const snapshot = runScriptFileJson(path.resolve('tests/tools/win-update-e2e/window-enum.ps1'))
  if (Array.isArray(snapshot?.windows)) {
    return snapshot.windows
  }
  return snapshot?.windows ? [snapshot.windows] : []
}

function hasVisibleWindow(pid) {
  if (process.platform === 'win32') {
    return readVisibleWindows().some((entry) => Number(entry.pid) === pid)
  }
  const probe = process.env.ORCA_QA_MAC_WINDOW_PROBE
  if (!probe) {
    throw new Error('ORCA_QA_MAC_WINDOW_PROBE is required on macOS')
  }
  const result = spawnSync(probe, [String(pid)], { encoding: 'utf8', timeout: 30_000 })
  if (result.error) {
    throw result.error
  }
  return result.status === 0 && result.stdout.trim() === 'visible'
}

function invokeBounded(args, lane, trafficLog, trafficResults) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(cliPath, args, { env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    if (child.pid) {
      ownedPids.add(child.pid)
    }
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => chunks.push(chunk))
    let settled = false
    let timer
    const finish = (result) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (child.pid) {
        ownedPids.delete(child.pid)
      }
      trafficResults[lane].calls += 1
      if (result.code === 0) {
        trafficResults[lane].successes += 1
      }
      writeFileSync(
        trafficLog,
        `${JSON.stringify({ lane, args, pid: child.pid, startedAt, finishedAt: Date.now(), durationMs: Date.now() - startedAt, ...result, output: Buffer.concat(chunks).toString('utf8').slice(0, 2000) })}\n`,
        { flag: 'a' }
      )
      resolve(result)
    }
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
    }, 10_000)
    child.once('exit', (code, signal) => finish({ code, signal }))
    child.once('error', (error) => finish({ error: error.message }))
  })
}

async function startTraffic(label) {
  const trafficLog = path.join(outputDir, `${label}-cli-traffic.jsonl`)
  const trafficResults = {
    status: { calls: 0, successes: 0 },
    orchestration: { calls: 0, successes: 0 }
  }
  if (trafficMode === 'none') {
    writeFileSync(
      trafficLog,
      `${JSON.stringify({ at: Date.now(), trafficMode, event: 'traffic-disabled' })}\n`
    )
    return {
      trafficResults,
      async stop() {}
    }
  }
  const commands = [
    ['status', ['status', '--json']],
    ['orchestration', ['orchestration', 'run-list', '--limit', '5', '--json']]
  ]
  const warmup = await Promise.all(
    commands.map(([lane, args]) => invokeBounded(args, lane, trafficLog, trafficResults))
  )
  if (warmup.some((result) => result.code !== 0)) {
    throw new Error(`${label} CLI traffic warmup failed: ${JSON.stringify(warmup)}`)
  }

  let stop = false
  const lanes = commands.map(async ([lane, args]) => {
    const deadline = Date.now() + 120_000
    while (!stop && Date.now() < deadline) {
      await invokeBounded(args, lane, trafficLog, trafficResults)
      if (!stop) {
        await sleep(750)
      }
    }
  })
  let stopPromise
  return {
    trafficResults,
    async stop() {
      stopPromise ??= (async () => {
        stop = true
        await Promise.all(lanes)
        if (
          trafficResults.status.calls < 2 ||
          trafficResults.orchestration.calls < 2 ||
          trafficResults.status.successes < 1 ||
          trafficResults.orchestration.successes < 1
        ) {
          throw new Error(`${label} bounded CLI traffic failed: ${JSON.stringify(trafficResults)}`)
        }
      })()
      await stopPromise
    }
  }
}

async function assertRuntimeVersion(runtime, expectedVersion, label) {
  const statusResult = await waitFor(
    () => {
      const result = spawnSync(cliPath, ['status', '--json'], {
        env: appEnv,
        encoding: 'utf8',
        timeout: 10_000
      })
      if (result.status !== 0 || !result.stdout.trim()) {
        return false
      }
      const parsed = JSON.parse(result.stdout)
      return parsed?.result?.runtime?.appVersion === expectedVersion &&
        parsed?.result?.app?.pid === runtime.pid &&
        parsed?.result?.app?.desktopWindowStatus === 'available'
        ? parsed
        : false
    },
    120_000,
    `${label} target runtime CLI status`,
    1_000
  )

  const cliVersion = spawnSync(cliPath, ['--version'], {
    env: appEnv,
    encoding: 'utf8',
    timeout: 10_000
  })
  if (cliVersion.status !== 0 || cliVersion.stdout.trim() !== expectedVersion) {
    throw new Error(
      `${label} packaged CLI version mismatch: ${cliVersion.stdout} ${cliVersion.stderr}`
    )
  }
  const replacementVisible = hasVisibleWindow(runtime.pid)
  if (!replacementVisible) {
    throw new Error(
      `${label} automatic replacement PID ${runtime.pid} has no visible top-level window`
    )
  }
  return { statusResult, cliVersion: cliVersion.stdout.trim(), replacementVisible }
}

async function runHop(session, targetTag, targetVersion, label, seenRuntimeIds) {
  const beforeVersion = await session.page.evaluate(() => window.api.updater.getVersion())
  if (beforeVersion === targetVersion) {
    throw new Error(`${label} source and target versions are identical: ${targetVersion}`)
  }
  const beforeStatus = await session.page.evaluate(() => window.api.updater.getStatus())
  if (beforeStatus.state !== 'idle') {
    throw new Error(`${label} started in non-idle updater state: ${JSON.stringify(beforeStatus)}`)
  }
  await session.page.screenshot({
    path: path.join(
      outputDir,
      `${label}-01-source-${session.settingsVisible ? 'idle' : 'visible-app'}.png`
    ),
    fullPage: false
  })

  await session.page.evaluate(
    ({ targetTag: tag }) => window.api.updater.check({ channel: 'adhoc', targetTag: tag }),
    { targetTag }
  )
  const available = await waitFor(
    () =>
      session.page
        .evaluate(() => window.api.updater.getStatus())
        .then((status) => (status.state === 'available' ? status : false)),
    120_000,
    `${label} pinned update available`,
    1_000
  )
  if (available.version !== targetVersion || available.source !== 'adhoc') {
    throw new Error(`${label} unexpected available status: ${JSON.stringify(available)}`)
  }
  await session.page.screenshot({
    path: path.join(outputDir, `${label}-02-update-available.png`),
    fullPage: false
  })

  await session.page.evaluate(() => window.api.updater.download())
  const downloaded = await waitFor(
    () =>
      session.page
        .evaluate(() => window.api.updater.getStatus())
        .then((status) => (status.state === 'downloaded' ? status : false)),
    300_000,
    `${label} pinned update downloaded`,
    1_000
  )
  if (downloaded.version !== targetVersion) {
    throw new Error(`${label} wrong downloaded version: ${JSON.stringify(downloaded)}`)
  }
  await session.page.screenshot({
    path: path.join(outputDir, `${label}-03-update-downloaded.png`),
    fullPage: false
  })

  const timeline = startInstallFileTimeline({
    label,
    outputDir,
    sourcePid: session.runtime.pid,
    exePath,
    cliPath,
    runtimePath
  })
  const traffic = await startTraffic(label)
  const recordLifecycle = createInstallLifecycleRecorder({ label, outputDir, trafficMode })
  let trafficStoppedAt = null
  const stopTraffic = async () => {
    if (trafficStoppedAt !== null) {
      return
    }
    await traffic.stop()
    trafficStoppedAt = Date.now()
    recordLifecycle('traffic-stopped', { trafficStoppedAt })
  }
  let completed = false
  try {
    const disconnected = new Promise((resolve) => session.browser.once('disconnected', resolve))
    const quitRequestedAt = Date.now()
    recordLifecycle('quit-requested', { quitRequestedAt, sourcePid: session.runtime.pid })
    await session.page.evaluate(() => window.api.updater.quitAndInstall())
    const oldExitTask = (async () => {
      await waitFor(
        () => !isPidAlive(session.runtime.pid),
        120_000,
        `${label} old authoritative PID exit`
      )
      const exitedAt = Date.now()
      recordLifecycle('old-pid-exited', { oldExitedAt: exitedAt, sourcePid: session.runtime.pid })
      ownedPids.delete(session.runtime.pid)
      if (trafficMode === 'until-old-exit') {
        await stopTraffic()
      }
      return exitedAt
    })()
    await Promise.race([
      disconnected,
      sleep(120_000).then(() => {
        throw new Error(`${label} initial CDP session did not disconnect for update`)
      })
    ])
    const cdpDisconnectedAt = Date.now()
    recordLifecycle('cdp-disconnected', { cdpDisconnectedAt })
    const oldExitedAt = await oldExitTask

    const replacement = await waitForRuntime(seenRuntimeIds, `${label} automatic replacement runtime`)
    const replacementObservedAt = Date.now()
    recordLifecycle('replacement-observed', {
      replacementObservedAt,
      replacementPid: replacement.pid,
      replacementRuntimeId: replacement.runtimeId
    })
    ownedPids.add(replacement.pid)
    seenRuntimeIds.add(replacement.runtimeId)
    writeFileSync(path.join(outputDir, `${label}-replacement-pid.txt`), `${replacement.pid}\n`)
    const runtimeEvidence = await assertRuntimeVersion(replacement, targetVersion, label)
    const automaticUpdaterStatus = await sendRuntimeRequest(
      replacement,
      'updater.getStatus',
      null
    )
    if (automaticUpdaterStatus?.state !== 'idle') {
      throw new Error(
        `${label} automatic replacement updater not idle: ${JSON.stringify(automaticUpdaterStatus)}`
      )
    }
    await stopTraffic()
    completed = true

    return {
      replacementRuntime: replacement,
      evidence: {
        beforeVersion,
        settingsSurfaceVisible: session.settingsVisible,
        targetTag,
        targetVersion,
        trafficMode,
        quitRequestedAt,
        cdpDisconnectedAt,
        oldExitedAt,
        trafficStoppedAt,
        replacementObservedAt,
        automaticUpdaterStatus,
        replacement: {
          pid: replacement.pid,
          runtimeId: replacement.runtimeId,
          startedAt: replacement.startedAt
        },
        ...runtimeEvidence,
        trafficResults: traffic.trafficResults
      }
    }
  } finally {
    await timeline.stop()
    if (!completed) {
      await stopTraffic()
    }
  }
}

const seenRuntimeIds = new Set()
let session = await launchDriven('source', seenRuntimeIds)
seenRuntimeIds.add(session.runtime.runtimeId)
const sourceVersion = await session.page.evaluate(() => window.api.updater.getVersion())

const firstHopResult = await runHop(session, finalTag, finalVersion, 'hop-1', seenRuntimeIds)
if (process.env.ORCA_QA_SINGLE_HOP === '1') {
  writeFileSync(
    path.join(outputDir, 'result.json'),
    JSON.stringify({ sourceVersion, firstHop: firstHopResult.evidence }, null, 2)
  )
  await terminateExactRuntime(
    { browser: session.browser, runtime: firstHopResult.replacementRuntime },
    'hop-1 automatic replacement'
  )
} else {
  await terminateExactRuntime(
    { browser: session.browser, runtime: firstHopResult.replacementRuntime },
    'hop-1 replacement'
  )
  session = await launchDriven('final-head', seenRuntimeIds)
  seenRuntimeIds.add(session.runtime.runtimeId)
  const finalHeadVersion = await session.page.evaluate(() => window.api.updater.getVersion())
  if (finalHeadVersion !== finalVersion) {
    throw new Error(`final-head relaunch version ${finalHeadVersion} != ${finalVersion}`)
  }
  const finalHeadIdleStatus = await session.page.evaluate(() => window.api.updater.getStatus())
  if (finalHeadIdleStatus.state !== 'idle') {
    throw new Error(`final-head relaunch updater not idle: ${JSON.stringify(finalHeadIdleStatus)}`)
  }
  await session.page.screenshot({
    path: path.join(outputDir, 'hop-1-04-final-head-idle.png'),
    fullPage: false
  })

  const secondHopResult = await runHop(session, higherTag, higherVersion, 'hop-2', seenRuntimeIds)
  await terminateExactRuntime(
    { browser: session.browser, runtime: secondHopResult.replacementRuntime },
    'hop-2 replacement'
  )
  session = await launchDriven('higher-final-head', seenRuntimeIds)
  seenRuntimeIds.add(session.runtime.runtimeId)
  const higherRuntimeVersion = await session.page.evaluate(() => window.api.updater.getVersion())
  if (higherRuntimeVersion !== higherVersion) {
    throw new Error(`higher-version relaunch version ${higherRuntimeVersion} != ${higherVersion}`)
  }
  const higherIdleStatus = await session.page.evaluate(() => window.api.updater.getStatus())
  if (higherIdleStatus.state !== 'idle') {
    throw new Error(`higher-version relaunch updater not idle: ${JSON.stringify(higherIdleStatus)}`)
  }
  if (session.settingsVisible) {
    await session.page.getByText(`Current version: ${higherVersion}`, { exact: true }).waitFor({
      state: 'visible',
      timeout: 30_000
    })
  }
  await session.page.screenshot({
    path: path.join(outputDir, 'hop-2-04-higher-final-head-idle.png'),
    fullPage: false
  })

  writeFileSync(
    path.join(outputDir, 'result.json'),
    JSON.stringify(
      {
        sourceVersion,
        finalHeadVersion,
        higherRuntimeVersion,
        finalHeadIdleStatus,
        higherIdleStatus,
        firstHop: firstHopResult.evidence,
        secondHop: secondHopResult.evidence
      },
      null,
      2
    )
  )

  await terminateExactRuntime(session, 'final driven runtime')
}
