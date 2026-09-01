import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isValidAppVersion } from '../shared/app-version'
import { runProcessSync, spawnProcess } from '../shared/child-process/run-process'
import { getProcessStartedAtMs } from './daemon/daemon-process-start-time'
import {
  clearMacUpdateInstallAttempt,
  getMacUpdateInstallAttemptPath,
  MAC_UPDATE_INSTALL_ATTEMPT_SCHEMA_VERSION,
  readMacUpdateInstallAttempt,
  writeMacUpdateInstallAttempt,
  type MacUpdateInstallAttempt,
  type MacUpdateInstallRecoveryReason
} from './mac-update-install-attempt-store'
export {
  clearMacUpdateInstallAttempt,
  getMacUpdateInstallAttemptPath,
  readMacUpdateInstallAttempt,
  writeMacUpdateInstallAttempt,
  type MacUpdateInstallAttempt,
  type MacUpdateInstallFailureReason,
  type MacUpdateInstallRecoveryReason
} from './mac-update-install-attempt-store'

export const MAC_UPDATE_INSTALL_ATTEMPT_STALE_MS = 15_000
export const MAC_UPDATE_INSTALL_ATTEMPT_MAX_AGE_MS = 15 * 60_000

const PROCESS_LIST_TIMEOUT_MS = 2_000
const PROCESS_LIST_MAX_BYTES = 16 * 1024 * 1024
export const MAC_UPDATE_INSTALL_MONITOR_ENTRY = 'mac-update-install-monitor-entry.js'

export type MacUpdateInstallLaunchDecision =
  | { action: 'allow'; reason: 'different-bundle' | 'no-attempt' }
  | { action: 'allow-and-clear'; reason: 'target-installed' | 'stale-attempt' }
  | {
      action: 'allow-with-failure'
      reason: 'install-abandoned' | 'recorded-failure'
      failureReason: MacUpdateInstallRecoveryReason
    }
  | { action: 'block'; reason: 'active-install' | 'shipit-alive' }

export type MacUpdateProcessIdentityState = 'alive' | 'dead' | 'unverifiable'

export function resolveMacUpdateBundlePath(executablePath: string): string {
  const bundlePath = resolve(executablePath, '..', '..', '..')
  if (!bundlePath.toLowerCase().endsWith('.app')) {
    throw new Error('The updater executable is not inside a macOS app bundle')
  }
  return bundlePath
}

export function isMacUpdateProcessIdentityAlive(
  pid: number,
  expectedStartedAtMs: number,
  readStartedAtMs: (pid: number) => number | null = getProcessStartedAtMs
): boolean {
  return getMacUpdateProcessIdentityState(pid, expectedStartedAtMs, readStartedAtMs) === 'alive'
}

/**
 * A failed process probe is not proof that the process exited. Keep that distinction so a
 * transient ps/TCC failure cannot make ShipIt race an otherwise live desktop owner.
 */
export function getMacUpdateProcessIdentityState(
  pid: number,
  expectedStartedAtMs: number,
  readStartedAtMs: (pid: number) => number | null = getProcessStartedAtMs
): MacUpdateProcessIdentityState {
  let actualStartedAtMs: number | null
  try {
    actualStartedAtMs = readStartedAtMs(pid)
  } catch {
    actualStartedAtMs = null
  }
  if (actualStartedAtMs !== null) {
    return actualStartedAtMs === expectedStartedAtMs ? 'alive' : 'dead'
  }
  try {
    process.kill(pid, 0)
    return 'unverifiable'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unverifiable'
  }
}

export function decideMacUpdateInstallLaunch(options: {
  attempt: MacUpdateInstallAttempt | null
  currentBundlePath: string
  currentVersion: string
  nowMs: number
  monitorAlive: boolean
  shipItAlive: boolean
}): MacUpdateInstallLaunchDecision {
  const { attempt } = options
  if (!attempt) {
    return { action: 'allow', reason: 'no-attempt' }
  }
  if (!macPathsEqual(attempt.targetBundlePath, options.currentBundlePath)) {
    return { action: 'allow', reason: 'different-bundle' }
  }
  if (options.currentVersion === attempt.targetVersion) {
    return { action: 'allow-and-clear', reason: 'target-installed' }
  }
  const ageMs = options.nowMs - attempt.createdAtMs
  if (ageMs < 0) {
    return { action: 'allow-and-clear', reason: 'stale-attempt' }
  }
  if (attempt.phase === 'failed') {
    return {
      action: 'allow-with-failure',
      reason: 'recorded-failure',
      failureReason: attempt.failureReason ?? 'monitor-exited'
    }
  }
  if (ageMs > MAC_UPDATE_INSTALL_ATTEMPT_MAX_AGE_MS) {
    return {
      action: 'allow-with-failure',
      reason: 'install-abandoned',
      failureReason: 'install-timed-out'
    }
  }
  if (options.monitorAlive) {
    return { action: 'block', reason: 'active-install' }
  }
  if (options.shipItAlive) {
    return { action: 'block', reason: 'shipit-alive' }
  }
  if (options.nowMs - attempt.heartbeatAtMs <= MAC_UPDATE_INSTALL_ATTEMPT_STALE_MS) {
    return { action: 'block', reason: 'active-install' }
  }
  return {
    action: 'allow-with-failure',
    reason: 'install-abandoned',
    failureReason: 'monitor-exited'
  }
}

export function armMacUpdateInstallAttempt(options: {
  appDataPath: string
  executablePath: string
  isPackaged: boolean
  platform?: NodeJS.Platform
  resourcesPath: string
  sourceVersion: string
  targetVersion: string
  nowMs?: number
  readProcessStartedAtMs?: (pid: number) => number | null
}): MacUpdateInstallAttempt | null {
  if ((options.platform ?? process.platform) !== 'darwin' || !options.isPackaged) {
    return null
  }
  if (!isValidAppVersion(options.sourceVersion) || !isValidAppVersion(options.targetVersion)) {
    throw new Error('The macOS update attempt requires valid source and target versions')
  }
  const readStartedAtMs = options.readProcessStartedAtMs ?? getProcessStartedAtMs
  const sourceStartedAtMs = readStartedAtMs(process.pid)
  if (sourceStartedAtMs === null) {
    throw new Error('Could not identify the macOS update source process')
  }
  const attemptId = randomUUID()
  const attemptPath = getMacUpdateInstallAttemptPath(options.appDataPath)
  const monitorEntry = join(
    options.resourcesPath,
    'app.asar.unpacked',
    'out',
    'main',
    MAC_UPDATE_INSTALL_MONITOR_ENTRY
  )
  if (!existsSync(monitorEntry)) {
    throw new Error('The macOS update monitor is missing from the app bundle')
  }
  const monitor = spawnProcess({
    program: options.executablePath,
    args: [monitorEntry, attemptPath, attemptId],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore'
  })
  monitor.on('error', () => {})
  if (!monitor.pid) {
    throw new Error('Could not start the macOS update monitor')
  }
  monitor.unref()
  const monitorStartedAtMs = readStartedAtMs(monitor.pid)
  if (monitorStartedAtMs === null) {
    throw new Error('Could not identify the macOS update monitor process')
  }
  const nowMs = options.nowMs ?? Date.now()
  const attempt: MacUpdateInstallAttempt = {
    schemaVersion: MAC_UPDATE_INSTALL_ATTEMPT_SCHEMA_VERSION,
    attemptId,
    sourceVersion: options.sourceVersion,
    targetVersion: options.targetVersion,
    targetBundlePath: resolveMacUpdateBundlePath(options.executablePath),
    sourcePid: process.pid,
    sourceStartedAtMs,
    monitorPid: monitor.pid,
    monitorStartedAtMs,
    phase: 'installing',
    createdAtMs: nowMs,
    heartbeatAtMs: nowMs
  }
  writeMacUpdateInstallAttempt(attemptPath, attempt)
  return attempt
}

export function resolveMacUpdateInstallStartup(options: {
  appDataPath: string
  appVersion: string
  executablePath: string
  isPackaged: boolean
  platform?: NodeJS.Platform
  nowMs?: number
  readProcessStartedAtMs?: (pid: number) => number | null
  readProcessList?: () => string
}): MacUpdateInstallLaunchDecision {
  if ((options.platform ?? process.platform) !== 'darwin' || !options.isPackaged) {
    return { action: 'allow', reason: 'no-attempt' }
  }
  const attemptPath = getMacUpdateInstallAttemptPath(options.appDataPath)
  const attempt = readMacUpdateInstallAttempt(attemptPath)
  if (!attempt) {
    return { action: 'allow', reason: 'no-attempt' }
  }
  const monitorAlive = getMacUpdateProcessIdentityState(
    attempt.monitorPid,
    attempt.monitorStartedAtMs,
    options.readProcessStartedAtMs
  ) !== 'dead'
  let shipItAlive = false
  if (!monitorAlive) {
    try {
      shipItAlive = isMatchingBundleShipItRunning(
        attempt.targetBundlePath,
        (options.readProcessList ?? readAllProcessCommands)()
      )
    } catch {
      shipItAlive = false
    }
  }
  const decision = decideMacUpdateInstallLaunch({
    attempt,
    currentBundlePath: resolveMacUpdateBundlePath(options.executablePath),
    currentVersion: options.appVersion,
    nowMs: options.nowMs ?? Date.now(),
    monitorAlive,
    shipItAlive
  })
  if (decision.action === 'allow-and-clear' || decision.action === 'allow-with-failure') {
    clearMacUpdateInstallAttempt(attemptPath, attempt.attemptId)
  }
  return decision
}

export function isMatchingBundleShipItRunning(
  targetBundlePath: string,
  processCommandList: string
): boolean {
  const shipItPath = join(
    targetBundlePath,
    'Contents',
    'Frameworks',
    'Squirrel.framework',
    'Resources',
    'ShipIt'
  )
  return processCommandList.split('\n').some((line) => {
    const command = line.trimStart()
    return command === shipItPath || command.startsWith(`${shipItPath} `)
  })
}

function readAllProcessCommands(): string {
  try {
    const result = runProcessSync({
      program: '/bin/ps',
      args: ['-ww', '-axo', 'command='],
      timeoutMs: PROCESS_LIST_TIMEOUT_MS,
      maxOutputBytes: PROCESS_LIST_MAX_BYTES
    })
    return result.code === 0 ? result.stdout : ''
  } catch {
    return ''
  }
}

function macPathsEqual(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    resolve(value)
      .replace(/^\/System\/Volumes\/Data(?=\/)/i, '')
      .normalize('NFC')
      .toLocaleLowerCase('en-US')
  return normalize(left) === normalize(right)
}
