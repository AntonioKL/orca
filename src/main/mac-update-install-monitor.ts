import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess, spawnProcess } from '../shared/child-process/run-process'
import {
  clearMacUpdateInstallAttempt,
  isMacUpdateProcessIdentityAlive,
  isMatchingBundleShipItRunning,
  readMacUpdateInstallAttempt,
  writeMacUpdateInstallAttempt,
  type MacUpdateInstallAttempt,
  type MacUpdateInstallFailureReason
} from './mac-update-install-attempt'

export const MAC_UPDATE_MONITOR_POLL_MS = 2_000
export const MAC_UPDATE_MONITOR_SHIPIT_APPEARANCE_MS = 30_000
export const MAC_UPDATE_MONITOR_SHIPIT_EXIT_GRACE_MS = 5_000
export const MAC_UPDATE_MONITOR_TIMEOUT_MS = 15 * 60_000

type MonitorObservation = {
  bundleVersion: string | null
  shipItAlive: boolean
  sourceAlive: boolean
}

export type MacUpdateMonitorDecision =
  | { action: 'continue'; shipItSeen: boolean; shipItMissingSinceMs: number | null }
  | { action: 'complete' }
  | { action: 'fail'; reason: MacUpdateInstallFailureReason }

export function decideMacUpdateMonitorStep(options: {
  attempt: MacUpdateInstallAttempt
  observation: MonitorObservation
  nowMs: number
  shipItSeen: boolean
  shipItMissingSinceMs: number | null
}): MacUpdateMonitorDecision {
  const { attempt, observation, nowMs } = options
  if (observation.bundleVersion === attempt.targetVersion) {
    return { action: 'complete' }
  }
  if (nowMs - attempt.createdAtMs >= MAC_UPDATE_MONITOR_TIMEOUT_MS) {
    return { action: 'fail', reason: 'install-timed-out' }
  }
  if (observation.sourceAlive) {
    return {
      action: 'continue',
      shipItSeen: options.shipItSeen || observation.shipItAlive,
      shipItMissingSinceMs: null
    }
  }
  if (observation.shipItAlive) {
    return { action: 'continue', shipItSeen: true, shipItMissingSinceMs: null }
  }
  if (!options.shipItSeen) {
    if (nowMs - attempt.createdAtMs >= MAC_UPDATE_MONITOR_SHIPIT_APPEARANCE_MS) {
      return { action: 'fail', reason: 'installer-never-started' }
    }
    return { action: 'continue', shipItSeen: false, shipItMissingSinceMs: null }
  }
  const missingSinceMs = options.shipItMissingSinceMs ?? nowMs
  if (nowMs - missingSinceMs >= MAC_UPDATE_MONITOR_SHIPIT_EXIT_GRACE_MS) {
    return { action: 'fail', reason: 'installer-exited-with-source-version' }
  }
  return { action: 'continue', shipItSeen: true, shipItMissingSinceMs: missingSinceMs }
}

export async function runMacUpdateInstallMonitor(options: {
  attemptPath: string
  attemptId: string
  now?: () => number
  wait?: (durationMs: number) => Promise<void>
  observe?: (attempt: MacUpdateInstallAttempt) => Promise<MonitorObservation>
  launchRecovery?: (attempt: MacUpdateInstallAttempt) => Promise<boolean>
}): Promise<'completed' | 'failed' | 'cancelled'> {
  const now = options.now ?? Date.now
  const wait = options.wait ?? waitFor
  let attempt = await waitForAttempt(options.attemptPath, options.attemptId, wait)
  if (!attempt) {
    return 'cancelled'
  }
  let shipItSeen = false
  let shipItMissingSinceMs: number | null = null

  for (;;) {
    const current = readMacUpdateInstallAttempt(options.attemptPath)
    if (!current || current.attemptId !== options.attemptId || current.phase !== 'installing') {
      return 'cancelled'
    }
    attempt = current
    const nowMs = now()
    const observation = await (options.observe ?? observeInstall)(attempt)
    const decision = decideMacUpdateMonitorStep({
      attempt,
      observation,
      nowMs,
      shipItSeen,
      shipItMissingSinceMs
    })
    if (decision.action === 'complete') {
      clearMacUpdateInstallAttempt(options.attemptPath, attempt.attemptId)
      return 'completed'
    }
    if (decision.action === 'fail') {
      const failed: MacUpdateInstallAttempt = {
        ...attempt,
        phase: 'failed',
        failureReason: decision.reason,
        heartbeatAtMs: nowMs,
        recoveryLaunchedAtMs: nowMs
      }
      writeMacUpdateInstallAttempt(options.attemptPath, failed)
      await (options.launchRecovery ?? launchRecoveryApp)(failed)
      return 'failed'
    }
    shipItSeen = decision.shipItSeen
    shipItMissingSinceMs = decision.shipItMissingSinceMs
    writeMacUpdateInstallAttempt(
      options.attemptPath,
      { ...attempt, heartbeatAtMs: nowMs },
      { durable: false }
    )
    await wait(MAC_UPDATE_MONITOR_POLL_MS)
  }
}

async function waitForAttempt(
  attemptPath: string,
  attemptId: string,
  wait: (durationMs: number) => Promise<void>
): Promise<MacUpdateInstallAttempt | null> {
  for (let index = 0; index < 20; index += 1) {
    const attempt = readMacUpdateInstallAttempt(attemptPath)
    if (attempt?.attemptId === attemptId) {
      return attempt
    }
    await wait(100)
  }
  return null
}

async function observeInstall(attempt: MacUpdateInstallAttempt): Promise<MonitorObservation> {
  const [bundleVersion, processList] = await Promise.all([
    readBundleVersion(attempt.targetBundlePath),
    readProcessList()
  ])
  return {
    bundleVersion,
    shipItAlive: isMatchingBundleShipItRunning(attempt.targetBundlePath, processList),
    sourceAlive: isMacUpdateProcessIdentityAlive(attempt.sourcePid, attempt.sourceStartedAtMs)
  }
}

async function readBundleVersion(bundlePath: string): Promise<string | null> {
  try {
    const plist = await readFile(join(bundlePath, 'Contents', 'Info.plist'), 'utf8')
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    return match?.[1]?.trim() || null
  } catch {
    return null
  }
}

async function readProcessList(): Promise<string> {
  try {
    const result = await runProcess({
      program: '/bin/ps',
      args: ['-ww', '-axo', 'command='],
      timeoutMs: 2_000,
      maxOutputBytes: 16 * 1024 * 1024
    })
    return result.code === 0 ? result.stdout : ''
  } catch {
    return ''
  }
}

async function launchRecoveryApp(attempt: MacUpdateInstallAttempt): Promise<boolean> {
  try {
    const child = spawnProcess({
      program: '/usr/bin/open',
      args: [attempt.targetBundlePath, '--args', `--update-install-recovery=${attempt.attemptId}`],
      detached: true,
      stdio: 'ignore'
    })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

function waitFor(durationMs: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, durationMs))
}
