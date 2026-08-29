import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import {
  cadenceSummary,
  classifyProcessStart,
  decodePowerShellCommand
} from './consumer-classifier.mjs'

const encoded = Buffer.from(
  'Get-CimInstance Win32_Process -Property PageFileUsage',
  'utf16le'
).toString('base64')
assert.match(decodePowerShellCommand(`powershell -EncodedCommand ${encoded}`), /PageFileUsage/)
assert.equal(
  classifyProcessStart({ name: 'powershell.exe', commandLine: `powershell -enc ${encoded}` }),
  'memory-collector'
)
assert.equal(
  classifyProcessStart({ name: 'powershell.exe', commandLine: 'powershell -c whoami' }),
  'unknown-powershell'
)
assert.equal(
  classifyProcessStart({ name: 'netstat', commandLine: 'netstat -ano -p tcp' }),
  'port-scan-netstat'
)
assert.deepEqual(
  cadenceSummary([
    { timestamp: '2026-01-01T00:00:00.000Z' },
    { timestamp: '2026-01-01T00:00:02.000Z' },
    { timestamp: '2026-01-01T00:00:04.100Z' }
  ]).intervalsMs,
  [2000, 2100]
)

if (process.platform === 'win32') {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-process-oracle-'))
  const output = path.join(dir, 'starts.ndjson')
  const ready = path.join(dir, 'ready')
  const watcher = spawn(
    process.execPath,
    [
      path.join(import.meta.dirname, 'process-snapshot-watch.mjs'),
      '--output',
      output,
      '--ready',
      ready,
      '--duration-ms',
      '5000'
    ],
    { stdio: 'inherit', windowsHide: true }
  )
  const readyDeadline = Date.now() + 5_000
  while (!existsSync(ready) && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(existsSync(ready), 'native observer did not become ready')
  const fixture = spawn(
    process.execPath,
    [path.join(import.meta.dirname, 'process-start-fixture.mjs'), '3', '400'],
    {
      stdio: 'inherit',
      windowsHide: true
    }
  )
  await new Promise((resolve, reject) =>
    fixture.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`))
    )
  )
  await new Promise((resolve, reject) =>
    watcher.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`watcher exited ${code}`))
    )
  )
  const rows = readFileSync(output, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
  const fixtureRows = rows.filter(
    (row) => row.parentPid === fixture.pid && row.name.toLowerCase() === 'node.exe'
  )
  assert.equal(fixtureRows.length, 3)
  assert.ok(fixtureRows.every((row) => row.argvCaptureStatus === 'captured'))

  const spawnDir = path.join(dir, 'spawn-calls')
  mkdirSync(spawnDir)
  const exactFixture = spawn(
    process.execPath,
    [path.join(import.meta.dirname, 'process-start-fixture.mjs'), '20', '0', '0'],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${path.join(import.meta.dirname, 'spawn-call-probe.cjs')}`,
        ORCA_PROCESS_ORACLE_SPAWN_DIR: spawnDir
      },
      stdio: 'inherit',
      windowsHide: true
    }
  )
  await new Promise((resolve, reject) =>
    exactFixture.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`exact fixture exited ${code}`))
    )
  )
  const exactRows = readFileSync(path.join(spawnDir, `${exactFixture.pid}.ndjson`), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse)
  const exactStarts = exactRows.filter((row) => row.type === 'spawn')
  assert.equal(exactStarts.length, 20)
  assert.ok(exactStarts.every((row) => Number.isInteger(row.returnedPid)))
  assert.ok(exactStarts.every((row) => row.stack.includes('process-start-fixture.mjs')))

  const filesBeforeSyncFixture = new Set(readdirSync(spawnDir))
  execFileSync(
    process.execPath,
    ['-e', "require('node:child_process').execFileSync(process.execPath, ['-e', '0'])"],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${path.join(import.meta.dirname, 'spawn-call-probe.cjs')}`,
        ORCA_PROCESS_ORACLE_SPAWN_DIR: spawnDir
      }
    }
  )
  const syncRows = readdirSync(spawnDir)
    .filter((file) => !filesBeforeSyncFixture.has(file))
    .flatMap((file) =>
      readFileSync(path.join(spawnDir, file), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    )
  const syncStarts = syncRows.filter((row) => row.type === 'spawn-sync')
  assert.equal(syncStarts.length, 1)
  assert.ok(Number.isInteger(syncStarts[0].returnedPid))
  assert.ok(syncStarts[0].stack.includes('[eval]'))

  const filesBeforeWorkerFixture = new Set(readdirSync(spawnDir))
  execFileSync(
    process.execPath,
    [
      '-e',
      `const { Worker } = require('node:worker_threads'); const worker = new Worker(${JSON.stringify(
        "require('node:child_process').execFileSync(process.execPath, ['-e', '0'])"
      )}, { eval: true }); worker.on('exit', (code) => { process.exitCode = code })`
    ],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${path.join(import.meta.dirname, 'spawn-call-probe.cjs')}`,
        ORCA_PROCESS_ORACLE_SPAWN_DIR: spawnDir
      }
    }
  )
  const workerRows = readdirSync(spawnDir)
    .filter((file) => !filesBeforeWorkerFixture.has(file))
    .flatMap((file) =>
      readFileSync(path.join(spawnDir, file), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    )
  const workerStarts = workerRows.filter((row) => row.type === 'spawn-sync')
  assert.equal(workerStarts.length, 1)
  assert.ok(workerStarts[0].threadId > 0)
  assert.ok(workerStarts[0].stack.includes('[worker eval]'))
  expectPreloadedThreadIds(workerRows, workerStarts[0].parentPid, [0, workerStarts[0].threadId])
}

function expectPreloadedThreadIds(rows, parentPid, expectedThreadIds) {
  assert.deepEqual(
    rows
      .filter((row) => row.type === 'preload' && row.parentPid === parentPid)
      .map((row) => row.threadId)
      .sort((left, right) => left - right),
    expectedThreadIds
  )
}

console.log('windows-process-polling-oracle tests passed')
