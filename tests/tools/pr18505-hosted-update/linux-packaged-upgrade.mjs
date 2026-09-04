import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  seedFreshProfile,
  buildFreshProfile,
  createSeededRepo
} from '../win-update-e2e/onboarding-profile.mjs'

const [exePathArg, expectedVersion, profileDirArg, outputDirArg, label, profileMode] =
  process.argv.slice(2)
if (
  !exePathArg ||
  !expectedVersion ||
  !profileDirArg ||
  !outputDirArg ||
  !label ||
  !['seed', 'reuse'].includes(profileMode)
) {
  throw new Error(
    'usage: linux-packaged-upgrade.mjs <exe> <version> <profile> <output> <label> <seed|reuse>'
  )
}
const exePath = path.resolve(exePathArg)
const profileDir = path.resolve(profileDirArg)
const outputDir = path.resolve(outputDirArg)
mkdirSync(outputDir, { recursive: true })
const isolatedHome = path.join(profileDir, 'home')
mkdirSync(isolatedHome, { recursive: true })
const profileDataPath = path.join(profileDir, 'orca-data.json')
if (profileMode === 'seed') {
  seedFreshProfile(
    profileDir,
    buildFreshProfile({ repo: createSeededRepo(path.join(profileDir, 'fixture-repo')) })
  )
} else if (!existsSync(profileDataPath)) {
  throw new Error(`upgraded package did not preserve the existing profile at ${profileDataPath}`)
}
const env = {
  ...process.env,
  ORCA_E2E_USER_DATA_DIR: profileDir,
  ORCA_E2E_HOME_DIR: isolatedHome,
  ORCA_USER_DATA_PATH: profileDir,
  ORCA_BACKGROUND_LAUNCH: '1',
  HOME: isolatedHome,
  ELECTRON_ENABLE_LOGGING: '1'
}
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(exePath, ['--no-sandbox', '--remote-debugging-port=9333'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
if (!app.pid) {
  throw new Error('packaged Linux app launch returned no PID')
}
const appPid = app.pid
const stopOwnedApp = () => {
  try {
    process.kill(appPid, 'SIGTERM')
  } catch {}
}
const isOwnedAppAlive = () => {
  try {
    process.kill(appPid, 0)
    return true
  } catch {
    return false
  }
}
process.once('exit', stopOwnedApp)
const logs = []
app.stdout.on('data', (chunk) => logs.push(chunk))
app.stderr.on('data', (chunk) => logs.push(chunk))
writeFileSync(path.join(outputDir, `${label}-pid.txt`), `${app.pid}\n`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deadline = Date.now() + 120_000
let cdpReady = false
while (Date.now() < deadline) {
  try {
    const response = await fetch('http://127.0.0.1:9333/json')
    const targets = await response.json()
    if (targets.some((target) => target.type === 'page')) {
      cdpReady = true
      break
    }
  } catch {}
  await sleep(500)
}
if (!cdpReady) {
  throw new Error('timed out waiting for packaged Linux CDP page')
}
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith('file:'))
if (!page) {
  throw new Error('no packaged Orca renderer page found')
}
await page.waitForLoadState('domcontentloaded')
await page.locator('body').waitFor({ state: 'visible', timeout: 60_000 })
const runtimeVersion = await page.evaluate(() => window.api.updater.getVersion())
if (runtimeVersion !== expectedVersion) {
  throw new Error(`runtime version ${runtimeVersion} != ${expectedVersion}`)
}
let settingsSurfaceVisible = false
try {
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
  await settingsButton.waitFor({ state: 'visible', timeout: 20_000 })
  await settingsButton.click({ timeout: 20_000 })
  await page
    .getByText('Updates', { exact: true })
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 })
  await page
    .getByText(`Current version: ${expectedVersion}`, { exact: true })
    .waitFor({ state: 'visible', timeout: 30_000 })
  settingsSurfaceVisible = true
} catch (error) {
  writeFileSync(
    path.join(outputDir, `${label}-settings-unavailable.json`),
    JSON.stringify(
      {
        error: String(error),
        bodyText: (await page.locator('body').innerText()).slice(0, 8_000),
        buttonLabels: await page.locator('button').evaluateAll((buttons) =>
          buttons.map(
            (button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''
          )
        )
      },
      null,
      2
    )
  )
}
await page.screenshot({ path: path.join(outputDir, `${label}-packaged.png`), fullPage: false })
writeFileSync(
  path.join(outputDir, `${label}-visible-state.json`),
  JSON.stringify(
    {
      pid: app.pid,
      profileMode,
      runtimeVersion,
      settingsSurfaceVisible,
      title: await page.title(),
      url: page.url(),
      bodyText: (await page.locator('body').innerText()).slice(0, 8000)
    },
    null,
    2
  )
)
await browser.close()
stopOwnedApp()
let cleanupDeadline = Date.now() + 15_000
while (isOwnedAppAlive() && Date.now() < cleanupDeadline) {
  await sleep(250)
}
if (isOwnedAppAlive()) {
  process.kill(appPid, 'SIGKILL')
  cleanupDeadline = Date.now() + 5_000
  while (isOwnedAppAlive() && Date.now() < cleanupDeadline) {
    await sleep(250)
  }
}
if (isOwnedAppAlive()) {
  throw new Error(`packaged Linux app PID ${appPid} did not exit after exact-PID cleanup`)
}
process.removeListener('exit', stopOwnedApp)
writeFileSync(path.join(outputDir, `${label}-app.log`), Buffer.concat(logs).toString('utf8'))
