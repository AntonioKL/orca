import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { buildFreshProfile, seedFreshProfile } from '../win-update-e2e/onboarding-profile.mjs'

const [appPathArg, targetTag, sourceVersion, targetVersion, outputDirArg] = process.argv.slice(2)
if (!appPathArg || !targetTag || !sourceVersion || !targetVersion || !outputDirArg) {
  throw new Error('usage: mac-final-live-update.mjs <app> <target-tag> <source-version> <target-version> <output-dir>')
}
if (process.platform !== 'darwin') throw new Error(`macOS required, got ${process.platform}`)
const appPath = path.resolve(appPathArg)
const outputDir = path.resolve(outputDirArg)

mkdirSync(outputDir, { recursive: true })
const profileDir = path.join(outputDir, 'profile')
const isolatedHome = path.join(profileDir, 'home')
mkdirSync(isolatedHome, { recursive: true })
const freshProfile = buildFreshProfile()
freshProfile.ui = { lastUpdateCheckAt: Date.now() }
seedFreshProfile(profileDir, freshProfile)

const cliPath = path.resolve(path.dirname(appPath), '..', 'Resources', 'bin', 'orca')
if (!existsSync(cliPath)) throw new Error(`packaged CLI missing: ${cliPath}`)
const appEnv = {
  ...process.env,
  ORCA_E2E_USER_DATA_DIR: profileDir,
  ORCA_E2E_HOME_DIR: isolatedHome,
  ORCA_USER_DATA_PATH: profileDir,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  ELECTRON_ENABLE_LOGGING: '1'
}
delete appEnv.ELECTRON_RUN_AS_NODE

const appLog = path.join(outputDir, 'app.log')
const appOut = await import('node:fs').then(({ openSync }) => openSync(appLog, 'a'))
const runtimePath = path.join(profileDir, 'orca-runtime.json')
const progressPath = path.join(outputDir, 'progress.jsonl')
const ownedPids = new Set()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout during ${label}`)), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

function evaluateBounded(page, pageFunction, arg, label) {
  return withTimeout(page.evaluate(pageFunction, arg), 10_000, label)
}

function markStage(stage, details = {}) {
  const record = { at: new Date().toISOString(), stage, ...details }
  writeFileSync(progressPath, `${JSON.stringify(record)}\n`, { flag: 'a' })
  console.log(`[mac-update-qa] ${JSON.stringify(record)}`)
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
    if (!isPidAlive(pid)) continue
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
}
process.once('exit', stopOwnedPids)

async function waitFor(predicate, timeoutMs, label, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await predicate()
      if (last) return last
    } catch (error) {
      last = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`timeout waiting for ${label}; last=${String(last)}`)
}

async function waitForRuntime(excludedRuntimeId, label) {
  return waitFor(() => {
    if (!existsSync(runtimePath)) return false
    const value = JSON.parse(readFileSync(runtimePath, 'utf8'))
    if (!Number.isInteger(value.pid) || value.pid <= 0 || typeof value.runtimeId !== 'string') return false
    if (value.runtimeId === excludedRuntimeId || !isPidAlive(value.pid)) return false
    return value
  }, 300_000, label, 1_000)
}

async function attachCdp() {
  await waitFor(async () => {
    const response = await fetch('http://127.0.0.1:9333/json', {
      signal: AbortSignal.timeout(2_000)
    })
    const targets = await response.json()
    return targets.some((target) => target.type === 'page')
  }, 120_000, 'CDP page')
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333', { timeout: 15_000 })
  const page = await waitFor(
    async () => {
      const pages = browser.contexts().flatMap((context) => context.pages())
      const snapshots = []
      for (const candidate of pages) {
        try {
          const state = await evaluateBounded(
            candidate,
            () => ({
              hasUpdater: Boolean(window.api?.updater),
              title: document.title,
              readyState: document.readyState,
              bodyChildren: document.body?.children.length ?? 0
            }),
            undefined,
            'renderer target inspection'
          )
          snapshots.push({ url: candidate.url(), ...state })
          if (state.hasUpdater && state.bodyChildren > 0) {
            writeFileSync(path.join(outputDir, 'cdp-pages.json'), JSON.stringify(snapshots, null, 2))
            return candidate
          }
        } catch {}
      }
      writeFileSync(path.join(outputDir, 'cdp-pages.json'), JSON.stringify(snapshots, null, 2))
      return false
    },
    60_000,
    'Orca renderer page'
  )
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 })
  return { browser, page }
}

async function waitForUpdaterState(page, expectedState, timeoutMs, phase) {
  const deadline = Date.now() + timeoutMs
  let previousStatus
  while (Date.now() < deadline) {
    const status = await evaluateBounded(
      page,
      () => window.api.updater.getStatus(),
      undefined,
      `${phase} updater status`
    )
    const serialized = JSON.stringify(status)
    if (serialized !== previousStatus) {
      previousStatus = serialized
      markStage('updater-status-transition', { phase, status })
    }
    if (status.state === 'error') throw new Error(`updater entered error state: ${serialized}`)
    if (status.state === expectedState) return status
    await sleep(1_000)
  }
  throw new Error(`timeout waiting for ${phase} ${expectedState}; last=${previousStatus}`)
}

function invokeBounded(args, lane, trafficLog, summary) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(cliPath, args, { env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    if (child.pid) ownedPids.add(child.pid)
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => chunks.push(chunk))
    let settled = false
    let forceTimer
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(forceTimer)
      if (child.pid && !isPidAlive(child.pid)) ownedPids.delete(child.pid)
      summary[lane].calls += 1
      if (result.code === 0) summary[lane].successes += 1
      writeFileSync(trafficLog, `${JSON.stringify({ lane, args, pid: child.pid, startedAt, durationMs: Date.now() - startedAt, ...result, output: Buffer.concat(chunks).toString('utf8').slice(0, 2000) })}\n`, { flag: 'a' })
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
      forceTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
        setTimeout(() => finish({ code: null, signal: 'SIGKILL', timedOut: true }), 2_000)
      }, 2_000)
    }, 10_000)
    child.once('exit', (code, signal) => finish({ code, signal }))
    child.once('error', (error) => finish({ error: error.message }))
  })
}

async function startTraffic() {
  const trafficLog = path.join(outputDir, 'cli-traffic.jsonl')
  const summary = { status: { calls: 0, successes: 0 }, orchestration: { calls: 0, successes: 0 } }
  const commands = [
    ['status', ['status', '--json']],
    ['orchestration', ['orchestration', 'run-list', '--limit', '5', '--json']]
  ]
  const warmup = await Promise.all(commands.map(([lane, args]) => invokeBounded(args, lane, trafficLog, summary)))
  if (warmup.some((result) => result.code !== 0)) throw new Error(`CLI warmup failed: ${JSON.stringify(warmup)}`)
  markStage('cli-traffic-warmup-complete', { summary })
  let stop = false
  const deadline = Date.now() + 120_000
  const lanes = commands.map(async ([lane, args]) => {
    while (!stop && Date.now() < deadline) {
      await invokeBounded(args, lane, trafficLog, summary)
      if (!stop) await sleep(750)
    }
  })
  return {
    summary,
    async stopTraffic() {
      stop = true
      await Promise.all(lanes)
      if (summary.status.successes < 1 || summary.orchestration.successes < 1) {
        throw new Error(`bounded CLI traffic had no success: ${JSON.stringify(summary)}`)
      }
    }
  }
}

function sendRuntimeRequest(metadata, method, params) {
  const transport = metadata.transports?.find((entry) => entry.kind === 'unix') ?? metadata.transport
  if (!transport?.endpoint || !metadata.authToken) throw new Error('runtime metadata has no usable local transport')
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const socket = createConnection(transport.endpoint)
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error(`runtime RPC ${method} timed out`)), 30_000)
    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.end()
      error ? reject(error) : resolve(value)
    }
    socket.setEncoding('utf8')
    socket.once('error', (error) => finish(error))
    socket.once('close', () => finish(new Error(`runtime RPC ${method} closed before response`)))
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1 && !settled) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.trim()) continue
        const frame = JSON.parse(line)
        if (frame._keepalive === true) continue
        if (frame.id !== id) return finish(new Error(`runtime RPC ${method} response ID mismatch`))
        if (frame.ok !== true) return finish(new Error(`runtime RPC ${method} failed: ${JSON.stringify(frame.error)}`))
        return finish(null, frame)
      }
    })
    socket.once('connect', () => socket.write(`${JSON.stringify({ id, authToken: metadata.authToken, method, params })}\n`))
  })
}

function runCli(args) {
  return spawnSync(cliPath, args, { env: appEnv, encoding: 'utf8', timeout: 10_000 })
}

async function waitForReplacementStatus(runtime) {
  return waitFor(() => {
    const result = runCli(['status', '--json'])
    if (result.status !== 0 || !result.stdout.trim()) return false
    const parsed = JSON.parse(result.stdout)
    return parsed?.result?.runtime?.appVersion === targetVersion &&
      parsed?.result?.app?.pid === runtime.pid &&
      parsed?.result?.app?.desktopWindowStatus === 'available' ? parsed : false
  }, 120_000, 'automatic replacement runtime/version/window', 1_000)
}

function collectEvidenceDirectories() {
  const roots = [
    path.join(isolatedHome, 'Library', 'Caches'),
    path.join(process.env.HOME, 'Library', 'Caches')
  ]
  const copied = []
  for (const root of [...new Set(roots)]) {
    if (!existsSync(root)) continue
    for (const name of readdirSync(root)) {
      if (!name.includes('ShipIt') && name !== 'com.stablyai.orca.updates') continue
      const source = path.join(root, name)
      const destination = path.join(outputDir, 'cache-evidence', `${Buffer.from(root).toString('hex').slice(-12)}-${name}`)
      cpSync(source, destination, { recursive: true })
      copied.push({ source, destination })
    }
  }
  return copied
}

function listFilesRecursively(root) {
  if (!existsSync(root)) return []
  const result = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(item)
      else result.push(item)
    }
  }
  visit(root)
  return result
}

const launcher = spawn(appPath, ['--remote-debugging-port=9333'], { env: appEnv, stdio: ['ignore', appOut, appOut] })
if (!launcher.pid) throw new Error('packaged source launch returned no PID')
ownedPids.add(launcher.pid)
launcher.once('exit', () => ownedPids.delete(launcher.pid))
writeFileSync(path.join(outputDir, 'source-launcher-pid.txt'), `${launcher.pid}\n`)
markStage('source-launched', { pid: launcher.pid })

const [{ browser, page }, sourceRuntime] = await Promise.all([attachCdp(), waitForRuntime(null, 'source runtime')])
markStage('source-runtime-and-renderer-ready', { pid: sourceRuntime.pid, runtimeId: sourceRuntime.runtimeId })
ownedPids.add(sourceRuntime.pid)
const seenRuntimeId = sourceRuntime.runtimeId
const actualSourceVersion = await evaluateBounded(
  page,
  () => window.api.updater.getVersion(),
  undefined,
  'source updater version'
)
if (actualSourceVersion !== sourceVersion) throw new Error(`source version ${actualSourceVersion} != ${sourceVersion}`)
const sourceStatus = await evaluateBounded(
  page,
  () => window.api.updater.getStatus(),
  undefined,
  'source updater status'
)
if (sourceStatus.state !== 'idle') throw new Error(`source updater not idle: ${JSON.stringify(sourceStatus)}`)

await page.keyboard.press('Meta+,')
await page.getByText('Updates', { exact: true }).first().waitFor({ state: 'visible', timeout: 60_000 })
await page.screenshot({ path: path.join(outputDir, '01-source-idle.png'), fullPage: false })
markStage('source-idle-screenshot-captured')
await evaluateBounded(
  page,
  ({ tag }) => window.api.updater.check({ channel: 'adhoc', targetTag: tag }),
  { tag: targetTag },
  'pinned update check'
)
const available = await waitForUpdaterState(page, 'available', 120_000, 'pinned-target')
if (available.version !== targetVersion || available.source !== 'adhoc') throw new Error(`unexpected available status: ${JSON.stringify(available)}`)
await page.screenshot({ path: path.join(outputDir, '02-update-available.png'), fullPage: false })
markStage('target-available', { version: available.version })
await evaluateBounded(page, () => {
  void window.api.updater.download()
  return true
}, undefined, 'download request')
const downloaded = await waitForUpdaterState(page, 'downloaded', 300_000, 'pinned-target')
if (downloaded.version !== targetVersion) throw new Error(`wrong downloaded version: ${JSON.stringify(downloaded)}`)
await page.screenshot({ path: path.join(outputDir, '03-update-downloaded.png'), fullPage: false })
markStage('target-downloaded', { version: downloaded.version })

const traffic = await startTraffic()
const disconnected = new Promise((resolve) => browser.once('disconnected', resolve))
markStage('quit-and-install-requesting')
await evaluateBounded(page, () => {
  void window.api.updater.quitAndInstall()
  return true
}, undefined, 'quit-and-install request')
markStage('quit-and-install-requested')
await Promise.race([disconnected, sleep(120_000).then(() => { throw new Error('source CDP did not disconnect for update') })])
markStage('source-cdp-disconnected')
await waitFor(() => !isPidAlive(sourceRuntime.pid), 120_000, 'source runtime exit')
markStage('source-runtime-exited', { pid: sourceRuntime.pid })
ownedPids.delete(sourceRuntime.pid)

const replacementRuntime = await waitForRuntime(seenRuntimeId, 'automatic replacement runtime')
markStage('replacement-runtime-ready', { pid: replacementRuntime.pid, runtimeId: replacementRuntime.runtimeId })
ownedPids.add(replacementRuntime.pid)
const cliStatus = await waitForReplacementStatus(replacementRuntime)
markStage('replacement-cli-status-ready')
const cliVersion = runCli(['--version'])
if (cliVersion.status !== 0 || cliVersion.stdout.trim() !== targetVersion) {
  throw new Error(`replacement CLI version mismatch: ${cliVersion.stdout} ${cliVersion.stderr}`)
}
const rpcStatus = await waitFor(async () => {
  const metadata = JSON.parse(readFileSync(runtimePath, 'utf8'))
  if (metadata.runtimeId !== replacementRuntime.runtimeId) return false
  const response = await sendRuntimeRequest(metadata, 'updater.getStatus', undefined)
  return response.result?.appVersion === targetVersion && response.result?.status?.state === 'idle' ? response.result : false
}, 120_000, 'automatic replacement updater.getStatus idle', 1_000)
markStage('replacement-updater-idle')
await traffic.stopTraffic()
markStage('cli-traffic-stopped', { summary: traffic.summary })

const installedBundleVersion = spawnSync(
  '/usr/libexec/PlistBuddy',
  ['-c', 'Print :CFBundleShortVersionString', '/Applications/Orca.app/Contents/Info.plist'],
  { encoding: 'utf8', timeout: 10_000 }
)
if (installedBundleVersion.status !== 0 || installedBundleVersion.stdout.trim() !== targetVersion) {
  throw new Error(`installed bundle version mismatch: ${installedBundleVersion.stdout} ${installedBundleVersion.stderr}`)
}

const copiedCaches = collectEvidenceDirectories()
const evidenceFiles = listFilesRecursively(path.join(outputDir, 'cache-evidence'))
const activeMarkers = evidenceFiles.filter((file) => path.basename(file).startsWith('attempt-') && file.endsWith('.json'))
if (activeMarkers.length) throw new Error(`active mac update markers remain: ${activeMarkers.join(', ')}`)
const shipItText = evidenceFiles.filter((file) => /ShipIt/i.test(file)).map((file) => readFileSync(file, 'utf8')).join('\n')
if (/Code=-9|App Still Running/i.test(shipItText)) throw new Error('ShipIt evidence contains Code=-9/App Still Running')

const result = {
  source: { version: actualSourceVersion, runtimeId: seenRuntimeId, pid: sourceRuntime.pid, updaterStatus: sourceStatus },
  target: { tag: targetTag, version: targetVersion, runtimeId: replacementRuntime.runtimeId, pid: replacementRuntime.pid },
  available,
  downloaded,
  cliStatus,
  cliVersion: cliVersion.stdout.trim(),
  installedBundleVersion: installedBundleVersion.stdout.trim(),
  runtimeRpcUpdaterStatus: rpcStatus,
  traffic: traffic.summary,
  activeMarkers,
  settledMarkers: evidenceFiles.filter((file) => path.basename(file).startsWith('settled-') && file.endsWith('.json')),
  shipItFailureMatch: false,
  copiedCaches
}
writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2))
markStage('validation-complete')

// Cleanup is intentionally limited to PIDs this harness recorded. The hosted runner destroys any remaining relaunch descendants.
stopOwnedPids()
