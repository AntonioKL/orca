import { randomUUID } from 'node:crypto'
import { statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import path from 'node:path'

export function sendRuntimeRequest(metadata, method, params) {
  const transport =
    metadata.transports?.find((entry) => ['unix', 'named-pipe'].includes(entry.kind)) ??
    metadata.transport
  if (!transport?.endpoint || !metadata.authToken) {
    throw new Error('runtime metadata has no compatible local transport')
  }
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const socket = createConnection(transport.endpoint)
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error(`runtime RPC ${method} timed out`)), 30_000)
    function finish(error, value) {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.end()
      if (error) {
        reject(error)
      } else {
        resolve(value)
      }
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
        if (!line.trim()) {
          continue
        }
        const frame = JSON.parse(line)
        if (frame._keepalive === true) {
          continue
        }
        if (frame.id !== id) {
          return finish(new Error(`runtime RPC ${method} response ID mismatch`))
        }
        if (frame.ok !== true) {
          return finish(new Error(`runtime RPC ${method} failed: ${JSON.stringify(frame.error)}`))
        }
        return finish(null, frame.result)
      }
    })
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ id, authToken: metadata.authToken, method, params })}\n`)
    )
  })
}

function snapshotFile(filePath) {
  try {
    const stat = statSync(filePath)
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return { exists: false }
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createInstallLifecycleRecorder({ label, outputDir, trafficMode }) {
  const lifecyclePath = path.join(outputDir, `${label}-install-lifecycle.jsonl`)
  return (event, extra = {}) => {
    writeFileSync(
      lifecyclePath,
      `${JSON.stringify({ event, at: Date.now(), trafficMode, ...extra })}\n`,
      { flag: 'a' }
    )
  }
}

export async function captureOptionalSettingsSurface(page, outputDir, label) {
  const settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
  try {
    await settingsButton.waitFor({ state: 'visible', timeout: 20_000 })
    await settingsButton.click({ timeout: 20_000 })
    await page.getByText('Updates', { exact: true }).first().waitFor({
      state: 'visible',
      timeout: 60_000
    })
    return true
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      bodyText: document.body?.innerText.slice(0, 8_000),
      buttonLabels: Array.from(document.querySelectorAll('button')).map(
        (button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''
      ),
      title: document.title,
      url: location.href,
      visibilityState: document.visibilityState,
      viewport: { width: innerWidth, height: innerHeight }
    }))
    writeFileSync(
      path.join(outputDir, `${label}-settings-unavailable.json`),
      JSON.stringify({ error: String(error), diagnostics }, null, 2)
    )
    await page.screenshot({
      path: path.join(outputDir, `${label}-visible-app.png`),
      fullPage: false
    })
    return false
  }
}

export function startInstallFileTimeline({
  label,
  outputDir,
  sourcePid,
  exePath,
  cliPath,
  runtimePath
}) {
  const timelinePath = path.join(outputDir, `${label}-install-file-timeline.jsonl`)
  let stopped = false
  const task = (async () => {
    while (!stopped) {
      writeFileSync(
        timelinePath,
        `${JSON.stringify({
          at: Date.now(),
          sourcePidAlive: isPidAlive(sourcePid),
          appExecutable: snapshotFile(exePath),
          cliExecutable: snapshotFile(cliPath),
          runtimeMetadata: snapshotFile(runtimePath)
        })}\n`,
        { flag: 'a' }
      )
      await sleep(250)
    }
  })()
  return {
    async stop() {
      stopped = true
      await task
    }
  }
}
