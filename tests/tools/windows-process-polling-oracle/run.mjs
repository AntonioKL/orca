import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import processTree from '@vscode/windows-process-tree'
import { buildFreshProfile, createSeededRepo } from '../win-update-e2e/onboarding-profile.mjs'
import {
  closeApp,
  dismissOverlays,
  ensureTerminal,
  launchInstalledApp,
  resolveElectronMainPid
} from '../win-update-e2e/app-driver.mjs'
import { readDaemonPidFiles } from '../win-update-e2e/daemon-processes.mjs'
import { cadenceSummary } from './consumer-classifier.mjs'
import { correlateObserverStarts, exactStartsForWindow } from './observer-spawn-cross-check.mjs'
import {
  initializeOracleOutputDirectory,
  trackChildExit,
  waitForChildExit,
  waitForObserverReady,
  waitForSuccessfulChildExit
} from './oracle-lifecycle.mjs'
import { collectRendererWindowMetrics } from './renderer-window-probe.mjs'

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index !== -1 ? process.argv[index + 1] : fallback
}

const exePath = path.resolve(arg('--exe', ''))
const outputDirArg = arg('--output', '')
const outputDir = outputDirArg ? path.resolve(outputDirArg) : ''
const label = arg('--label', path.basename(exePath))
const resourceState = arg('--resource', 'closed')
const durationMs = Number(arg('--duration-ms', '60000'))
const observerDurationMs = Number(arg('--observer-duration-ms', String(durationMs)))
if (!existsSync(exePath)) {
  throw new Error(`--exe does not exist: ${exePath}`)
}
if (!outputDir) {
  throw new Error('--output is required')
}
if (!['closed', 'open'].includes(resourceState)) {
  throw new Error('--resource must be closed or open')
}
if (!Number.isFinite(durationMs) || durationMs < 5_000) {
  throw new Error('--duration-ms must be >= 5000')
}
if (!Number.isFinite(observerDurationMs) || observerDurationMs < 5_000) {
  throw new Error('--observer-duration-ms must be >= 5000')
}

const startsPath = path.join(outputDir, 'process-starts.ndjson')
const readyPath = path.join(outputDir, 'observer.ready')
const stopPath = path.join(outputDir, 'observer.stop')
const loopPath = path.join(outputDir, 'event-loop.ndjson')
const spawnCallDir = path.join(outputDir, 'spawn-calls')
const probePath = path.join(import.meta.dirname, 'event-loop-probe.cjs')
const spawnProbePath = path.join(import.meta.dirname, 'spawn-call-probe.cjs')
const watcherPath = path.join(import.meta.dirname, 'process-snapshot-watch.mjs')
initializeOracleOutputDirectory(outputDir)
mkdirSync(spawnCallDir)
const runRoot = mkdtempSync(path.join(tmpdir(), 'orca-process-oracle-'))
const userDataDir = path.join(runRoot, 'profile')
const isolatedLocalAppData = path.join(runRoot, 'local-app-data')
const repo = createSeededRepo(path.join(runRoot, 'repo'))
let app
let watcher
let watcherExit
let daemonPids = []
let instrumentationRestartSucceeded = null
mkdirSync(isolatedLocalAppData, { recursive: true })

try {
  const launched = await launchInstalledApp({
    exePath,
    userDataDir,
    seedProfile: {
      ...buildFreshProfile({ repo }),
      ui: { statusBarItems: ['resource-usage'], statusBarVisible: true }
    },
    extraEnv: {
      LOCALAPPDATA: isolatedLocalAppData,
      NODE_OPTIONS: `--require=${probePath} --require=${spawnProbePath}`,
      ORCA_PROCESS_ORACLE_EVENT_LOOP_PATH: loopPath,
      ORCA_PROCESS_ORACLE_SPAWN_DIR: spawnCallDir
    }
  })
  app = launched.app
  const { page } = launched
  await installOracleInMain(app, {
    eventLoopPath: loopPath,
    eventLoopProbePath: probePath,
    spawnCallDir,
    spawnProbePath
  })
  const daemonRestart = await page.evaluate(() => window.api.pty.management.restart())
  instrumentationRestartSucceeded = daemonRestart.success
  await ensureTerminal(page)
  await dismissOverlays(page)
  const ptyId = await waitForPersistedPtyId(userDataDir, 30_000)
  const mainPid = await resolveElectronMainPid(app, { allowLauncherFallback: false })
  if (!mainPid) {
    throw new Error('could not resolve authoritative Electron main PID')
  }
  const pidDeadline = Date.now() + 30_000
  do {
    daemonPids = readDaemonPidFiles(userDataDir)
      .map((record) => record.pid)
      .filter(Number.isInteger)
    if (daemonPids.length === 1) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (Date.now() < pidDeadline)
  if (daemonPids.length !== 1) {
    throw new Error(`expected one scoped daemon PID, found ${daemonPids.length}`)
  }

  const resourceButton = page.getByRole('button', { name: /Resource Manager/i }).first()
  if (resourceState === 'open') {
    if (!(await resourceButton.isVisible().catch(() => false))) {
      const buttons = await page.locator('button').evaluateAll((nodes) =>
        nodes
          .map((node) => ({
            ariaLabel: node.getAttribute('aria-label'),
            text: node.textContent?.trim()
          }))
          .filter((row) => row.ariaLabel || row.text)
      )
      throw new Error(
        `Resource Manager button is not visible: ${JSON.stringify(buttons.slice(-40))}`
      )
    }
    await resourceButton.click({ timeout: 15_000 })
    await page
      .getByText('Resource Manager', { exact: true })
      .last()
      .waitFor({ state: 'visible', timeout: 15_000 })
  }
  await page.waitForTimeout(5_000)
  const memoryBefore = await page.evaluate(() => window.api.memory.getSnapshot())
  const windowStart = new Date().toISOString()
  const windowMetrics = await page.evaluate(collectRendererWindowMetrics, {
    windowMs: durationMs,
    ptyId
  })
  const windowEnd = new Date().toISOString()
  const memoryAfter = await page.evaluate(() => window.api.memory.getSnapshot())
  const resourceLabel = await resourceButton.getAttribute('aria-label')

  // Keep the 25ms host-wide observer out of the event-loop evidence window.
  watcher = spawn(
    process.execPath,
    [
      watcherPath,
      '--output',
      startsPath,
      '--ready',
      readyPath,
      '--stop',
      stopPath,
      '--duration-ms',
      String(observerDurationMs + 11_000)
    ],
    { stdio: 'inherit', windowsHide: true }
  )
  watcherExit = trackChildExit(watcher)
  await waitForObserverReady({ readyPath, exit: watcherExit, timeoutMs: 10_000 })
  const observerWindowStart = new Date().toISOString()
  const observerWindowMetrics = await page.evaluate(collectRendererWindowMetrics, {
    windowMs: observerDurationMs,
    ptyId,
    collectEventLoop: false
  })
  const observerWindowEnd = new Date().toISOString()
  writeFileSync(stopPath, '', { flag: 'wx' })
  await waitForSuccessfulChildExit(watcherExit, 'native process observer', 10_000)

  const rawRows = readNdjson(startsPath)
  const observer = rawRows.find((row) => row.type === 'summary')
  if (!observer) {
    throw new Error('native process observer did not publish its summary')
  }
  const startMs = Date.parse(windowStart)
  const endMs = Date.parse(windowEnd)
  const observerStartMs = Date.parse(observerWindowStart)
  const observerEndMs = Date.parse(observerWindowEnd)
  const observerRows = rawRows.filter(
    (row) =>
      row.type !== 'summary' &&
      Date.parse(row.timestamp) >= observerStartMs &&
      Date.parse(row.timestamp) <= observerEndMs
  )
  const rootPids = new Set([mainPid, ...daemonPids])
  const observerDirectChildren = observerRows.filter((row) => rootPids.has(row.parentPid))
  const spawnRows = readNdjsonDirectory(spawnCallDir)
  const preloadPids = new Set(
    spawnRows.filter((row) => row.type === 'preload').map((row) => row.parentPid)
  )
  const missingPreloads = [...rootPids].filter((pid) => !preloadPids.has(pid))
  if (missingPreloads.length > 0) {
    throw new Error(
      `spawn-call preload missing from authoritative roots: ${missingPreloads.join(', ')}`
    )
  }
  const exactStarts = exactStartsForWindow(spawnRows, rootPids, startMs, endMs)
  const observerExactStarts = exactStartsForWindow(
    spawnRows,
    rootPids,
    observerStartMs,
    observerEndMs
  )
  const observerCrossCheck = correlateObserverStarts(observerDirectChildren, observerExactStarts)
  const classified = exactStarts
  const byConsumer = Object.groupBy(classified, (row) => row.consumer)
  const eventLoop = readNdjson(loopPath).filter(
    (row) =>
      rootPids.has(row.pid) &&
      Date.parse(row.timestamp) >= startMs &&
      Date.parse(row.timestamp) <= endMs
  )
  const bundleFiles = [
    import.meta.filename,
    watcherPath,
    probePath,
    spawnProbePath,
    path.join(import.meta.dirname, 'consumer-classifier.mjs'),
    path.join(import.meta.dirname, 'oracle-lifecycle.mjs'),
    path.join(import.meta.dirname, 'observer-spawn-cross-check.mjs'),
    path.join(import.meta.dirname, 'renderer-window-probe.mjs'),
    path.join(import.meta.dirname, 'oracle-seam.mjs'),
    path.join(import.meta.dirname, '..', 'win-update-e2e', 'app-driver.mjs'),
    path.join(import.meta.dirname, '..', 'win-update-e2e', 'onboarding-profile.mjs'),
    path.join(import.meta.dirname, '..', 'win-update-e2e', 'daemon-processes.mjs'),
    requireResolveWindowsProcessTreeBinary()
  ]
  const report = {
    schemaVersion: 3,
    label,
    resourceState,
    foregroundFixture: 'stable-shell',
    exePath,
    exeSha256: sha256Files([exePath]),
    productHashes: collectProductHashes({
      exePath,
      isolatedLocalAppData
    }),
    oracleSha256: sha256Files(bundleFiles),
    oracleFiles: bundleFiles.map((file) => path.basename(file)),
    durationMs,
    windowStart,
    windowEnd,
    mainPid,
    daemonPids,
    spawnPreloadPids: [...preloadPids].filter((pid) => rootPids.has(pid)),
    instrumentationRestartSucceeded,
    subprocessCount: classified.length,
    subprocesses: classified,
    consumers: Object.fromEntries(
      Object.entries(byConsumer).map(([name, events]) => [name, cadenceSummary(events)])
    ),
    // Compatibility projections; all observer data belongs to the later cross-check phase.
    observerSubprocessCount: observerDirectChildren.length,
    observerSubprocesses: observerDirectChildren,
    eventLoop,
    eventLoopPreloadAvailable: eventLoop.length > 0,
    rendererEventLoop: windowMetrics.rendererEventLoop,
    foregroundProbe: windowMetrics.foregroundProbe,
    observer,
    observerCrossCheck: {
      durationMs: observerDurationMs,
      windowStart: observerWindowStart,
      windowEnd: observerWindowEnd,
      foregroundProbe: observerWindowMetrics.foregroundProbe,
      exactSubprocessCount: observerExactStarts.length,
      exactSubprocesses: observerExactStarts,
      observerSubprocessCount: observerDirectChildren.length,
      observerSubprocesses: observerDirectChildren,
      ...observerCrossCheck,
      observer
    },
    memoryBefore,
    memoryAfter,
    resourceLabel
  }
  writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx'
  })
  console.log(JSON.stringify(report, null, 2))
  if (!observerCrossCheck.complete) {
    throw new Error(
      `native observer found ${observerCrossCheck.unmatchedObserverStarts.length} child start(s) missing from exact spawn instrumentation`
    )
  }
} finally {
  if (watcher && watcher.exitCode === null) {
    watcher.kill()
  }
  if (watcherExit) {
    try {
      await waitForChildExit(watcherExit, 'native process observer cleanup', 5_000)
    } catch (error) {
      console.warn(error instanceof Error ? error.message : String(error))
    }
  }
  await closeApp(app)
  const cleanupPids = new Set([
    ...daemonPids,
    ...readDaemonPidFiles(userDataDir)
      .map((record) => record.pid)
      .filter(Number.isInteger)
  ])
  const ownedDaemonPids = await findOwnedDaemonPids(cleanupPids, [
    userDataDir,
    isolatedLocalAppData
  ])
  for (const pid of ownedDaemonPids) {
    try {
      process.kill(pid)
    } catch {
      // The isolated daemon may have already exited.
    }
  }
}

async function installOracleInMain(
  app,
  { eventLoopPath, eventLoopProbePath, spawnCallDir, spawnProbePath }
) {
  await app.evaluate(
    (_electron, { eventLoopPath, eventLoopProbePath, spawnCallDir, spawnProbePath }) => {
      process.env.ORCA_PROCESS_ORACLE_EVENT_LOOP_PATH = eventLoopPath
      process.env.ORCA_PROCESS_ORACLE_SPAWN_DIR = spawnCallDir
      process.env.NODE_OPTIONS = `--require=${eventLoopProbePath} --require=${spawnProbePath}`
      const moduleApi = process.getBuiltinModule('node:module')
      const pathApi = process.getBuiltinModule('node:path')
      const load = moduleApi.createRequire(
        pathApi.join(process.cwd(), 'orca-process-oracle-main.cjs')
      )
      load(eventLoopProbePath)
      load(spawnProbePath)
    },
    { eventLoopPath, eventLoopProbePath, spawnCallDir, spawnProbePath }
  )
}

async function findOwnedDaemonPids(candidatePids, ownershipPaths) {
  if (candidatePids.size === 0) {
    return []
  }
  const rows = await new Promise((resolve, reject) => {
    processTree.getAllProcesses(
      (processRows) =>
        Array.isArray(processRows)
          ? resolve(processRows)
          : reject(new Error('native cleanup snapshot returned no rows')),
      processTree.ProcessDataFlag.CommandLine
    )
  })
  const needles = ownershipPaths.map((entry) => entry.toLowerCase())
  return rows
    .filter((row) => candidatePids.has(row.pid))
    .filter((row) => {
      const commandLine = row.commandLine?.toLowerCase() ?? ''
      return (
        commandLine.includes('daemon-entry.js') &&
        needles.some((needle) => commandLine.includes(needle))
      )
    })
    .map((row) => row.pid)
}

function readNdjson(filePath) {
  if (!existsSync(filePath)) {
    return []
  }
  return readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
}

function readNdjsonDirectory(directory) {
  if (!existsSync(directory)) {
    return []
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith('.ndjson'))
    .flatMap((name) => readNdjson(path.join(directory, name)))
}

async function waitForPersistedPtyId(userDataDir, timeoutMs) {
  const statePath = path.join(userDataDir, 'profiles', 'local-default', 'orca-data.json')
  const deadline = Date.now() + timeoutMs
  do {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      const tabsByWorktree = state.workspaceSession?.tabsByWorktree ?? {}
      const ptyId = Object.values(tabsByWorktree)
        .flat()
        .findLast((tab) => typeof tab?.ptyId === 'string')?.ptyId
      if (ptyId) {
        return ptyId
      }
    } catch {
      // The profile state is written asynchronously after session creation.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error(`stable terminal ptyId was not persisted at ${statePath}`)
}

function sha256Files(files) {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(readFileSync(file))
  }
  return hash.digest('hex')
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function hashExistingFiles(root, relativePaths) {
  return relativePaths
    .map((relativePath) => ({ relativePath, filePath: path.join(root, relativePath) }))
    .filter(({ filePath }) => existsSync(filePath))
    .map(({ relativePath, filePath }) => ({
      path: relativePath.replaceAll('\\', '/'),
      sha256: sha256File(filePath),
      bytes: statSync(filePath).size
    }))
}

function collectProductHashes({ exePath, isolatedLocalAppData }) {
  const resourcesDir = path.join(path.dirname(exePath), 'resources')
  const packaged = hashExistingFiles(resourcesDir, [
    'app.asar',
    path.join(
      'node_modules',
      '@vscode',
      'windows-process-tree',
      'build',
      'Release',
      'windows_process_tree.node'
    ),
    path.join(
      'app.asar.unpacked',
      'node_modules',
      '@vscode',
      'windows-process-tree',
      'build',
      'Release',
      'windows_process_tree.node'
    )
  ])
  const daemonHostRoot = path.join(isolatedLocalAppData, 'Orca', 'daemon-host')
  const relocated = existsSync(daemonHostRoot)
    ? listFiles(daemonHostRoot)
        .filter((filePath) =>
          /(?:orca-terminal-daemon\.exe|daemon-entry\.js|windows_process_tree\.node|\.materialized\.json)$/i.test(
            filePath
          )
        )
        .map((filePath) => ({
          path: path.relative(daemonHostRoot, filePath).replaceAll('\\', '/'),
          sha256: sha256File(filePath),
          bytes: statSync(filePath).size
        }))
    : []
  return {
    packaged,
    relocated
  }
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        return listFiles(entryPath)
      }
      return statSync(entryPath).isFile() ? [entryPath] : []
    })
    .sort()
}

function requireResolveWindowsProcessTreeBinary() {
  const packageEntry = createRequire(import.meta.url).resolve('@vscode/windows-process-tree')
  return path.resolve(
    path.dirname(packageEntry),
    '..',
    'build',
    'Release',
    'windows_process_tree.node'
  )
}
