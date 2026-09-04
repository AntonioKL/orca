import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { locateInstalledExe } from '../win-update-e2e/installer-steps.mjs'
import { runScriptFileJson } from '../win-update-e2e/powershell-runner.mjs'

const [expectedVersion, profileDirArg, outputDirArg] = process.argv.slice(2)
if (!expectedVersion || !profileDirArg || !outputDirArg || process.platform !== 'win32') {
  throw new Error('usage: windows-manual-recovery.mjs <version> <profile> <output> (Windows only)')
}
const profileDir = path.resolve(profileDirArg)
const outputDir = path.resolve(outputDirArg)
mkdirSync(outputDir, { recursive: true })
const exePath = locateInstalledExe()
if (!exePath) {
  throw new Error('updated Orca.exe is not installed')
}
const cliPath = path.join(path.dirname(exePath), 'resources', 'bin', 'orca.exe')
const runtimePath = path.join(profileDir, 'orca-runtime.json')
const isolatedHome = path.join(profileDir, 'home')
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
const ownedPids = new Set()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) {
        return value
      }
    } catch {}
    await sleep(500)
  }
  throw new Error(`timeout waiting for ${label}`)
}

const recoveryLog = path.join(outputDir, 'manual-recovery-app.log')
const appOut = await import('node:fs').then(({ openSync }) => openSync(recoveryLog, 'a'))
const launcher = spawn(exePath, ['--remote-debugging-port=9333'], {
  env: appEnv,
  stdio: ['ignore', appOut, appOut]
})
if (!launcher.pid) {
  throw new Error('manual recovery launch returned no PID')
}
ownedPids.add(launcher.pid)
launcher.once('exit', () => ownedPids.delete(launcher.pid))
writeFileSync(path.join(outputDir, 'manual-recovery-launcher-pid.txt'), `${launcher.pid}\n`)

const runtime = await waitFor(() => {
  if (!existsSync(runtimePath)) {
    return false
  }
  const value = JSON.parse(readFileSync(runtimePath, 'utf8'))
  return Number.isInteger(value.pid) && isPidAlive(value.pid) ? value : false
}, 120_000, 'manual recovery runtime')
ownedPids.add(runtime.pid)

await waitFor(async () => {
  const response = await fetch('http://127.0.0.1:9333/json')
  const targets = await response.json()
  return targets.some((target) => target.type === 'page')
}, 120_000, 'manual recovery CDP page')
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
const page = await waitFor(() => {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith('file:'))
}, 60_000, 'manual recovery renderer')
await page.waitForLoadState('domcontentloaded')
const [runtimeVersion, updaterStatus] = await Promise.all([
  page.evaluate(() => window.api.updater.getVersion()),
  page.evaluate(() => window.api.updater.getStatus())
])
if (runtimeVersion !== expectedVersion || updaterStatus.state !== 'idle') {
  throw new Error(
    `manual recovery state mismatch: ${JSON.stringify({ runtimeVersion, updaterStatus })}`
  )
}
const cliVersion = spawnSync(cliPath, ['--version'], {
  env: appEnv,
  encoding: 'utf8',
  timeout: 10_000
})
if (cliVersion.status !== 0 || cliVersion.stdout.trim() !== expectedVersion) {
  throw new Error(`manual recovery CLI mismatch: ${cliVersion.stdout} ${cliVersion.stderr}`)
}
const windows = runScriptFileJson(path.resolve('tests/tools/win-update-e2e/window-enum.ps1'))
const visible = (Array.isArray(windows?.windows) ? windows.windows : [windows?.windows]).some(
  (entry) => Number(entry?.pid) === runtime.pid
)
if (!visible) {
  throw new Error(`manual recovery PID ${runtime.pid} has no visible top-level window`)
}
await page.screenshot({ path: path.join(outputDir, 'manual-recovery-idle.png'), fullPage: false })
writeFileSync(
  path.join(outputDir, 'manual-recovery-result.json'),
  JSON.stringify(
    {
      expectedVersion,
      runtimeVersion,
      updaterStatus,
      cliVersion: cliVersion.stdout.trim(),
      exePath,
      launcherPid: launcher.pid,
      runtimePid: runtime.pid,
      runtimeId: runtime.runtimeId,
      visible
    },
    null,
    2
  )
)
await browser.close()
stopOwnedPids()
await waitFor(() => [...ownedPids].every((pid) => !isPidAlive(pid)), 30_000, 'owned PID exit')
process.removeListener('exit', stopOwnedPids)
