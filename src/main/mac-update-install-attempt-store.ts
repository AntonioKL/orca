import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isValidAppVersion } from '../shared/app-version'
import { writeDurableSecureJsonFile, writeSecureJsonFile } from '../shared/secure-file'

export const MAC_UPDATE_INSTALL_ATTEMPT_SCHEMA_VERSION = 1

const ATTEMPT_DIRECTORY = 'com.stablyai.orca'
const ATTEMPT_FILENAME = 'update-install-attempt-v1.json'
const ATTEMPT_MAX_BYTES = 32 * 1024

export type MacUpdateInstallFailureReason =
  | 'installer-exited-with-source-version'
  | 'installer-never-started'
  | 'install-timed-out'
export type MacUpdateInstallRecoveryReason = MacUpdateInstallFailureReason | 'monitor-exited'

export type MacUpdateInstallAttempt = {
  schemaVersion: 1
  attemptId: string
  sourceVersion: string
  targetVersion: string
  targetBundlePath: string
  sourcePid: number
  sourceStartedAtMs: number
  monitorPid: number
  monitorStartedAtMs: number
  phase: 'installing' | 'failed'
  createdAtMs: number
  heartbeatAtMs: number
  failureReason?: MacUpdateInstallFailureReason
  recoveryLaunchedAtMs?: number
}

type AttemptReadResult =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'valid'; attempt: MacUpdateInstallAttempt }

export function getMacUpdateInstallAttemptPath(appDataPath: string): string {
  return join(appDataPath, ATTEMPT_DIRECTORY, ATTEMPT_FILENAME)
}

export function readMacUpdateInstallAttempt(attemptPath: string): MacUpdateInstallAttempt | null {
  const result = readAttempt(attemptPath)
  return result.kind === 'valid' ? result.attempt : null
}

export function writeMacUpdateInstallAttempt(
  attemptPath: string,
  attempt: MacUpdateInstallAttempt,
  options: { durable?: boolean } = {}
): void {
  if (options.durable === false) {
    writeSecureJsonFile(attemptPath, attempt)
  } else {
    writeDurableSecureJsonFile(attemptPath, attempt)
  }
}

export function clearMacUpdateInstallAttempt(
  attemptPath: string,
  expectedAttemptId?: string
): void {
  if (expectedAttemptId) {
    const current = readAttempt(attemptPath)
    if (current.kind === 'valid' && current.attempt.attemptId !== expectedAttemptId) {
      return
    }
  }
  try {
    rmSync(attemptPath, { force: true })
  } catch {
    // A stale attempt self-expires; cleanup must never prevent startup.
  }
}

function readAttempt(attemptPath: string): AttemptReadResult {
  try {
    if (!existsSync(attemptPath)) {
      return { kind: 'missing' }
    }
    const stats = lstatSync(attemptPath)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > ATTEMPT_MAX_BYTES) {
      return { kind: 'invalid' }
    }
    const value = JSON.parse(readFileSync(attemptPath, 'utf8')) as Record<string, unknown>
    if (!isValidAttempt(value)) {
      return { kind: 'invalid' }
    }
    return { kind: 'valid', attempt: value as MacUpdateInstallAttempt }
  } catch {
    return { kind: 'invalid' }
  }
}

function isValidAttempt(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === MAC_UPDATE_INSTALL_ATTEMPT_SCHEMA_VERSION &&
    typeof value.attemptId === 'string' &&
    typeof value.sourceVersion === 'string' &&
    isValidAppVersion(value.sourceVersion) &&
    typeof value.targetVersion === 'string' &&
    isValidAppVersion(value.targetVersion) &&
    typeof value.targetBundlePath === 'string' &&
    value.targetBundlePath.startsWith('/') &&
    value.targetBundlePath.toLowerCase().endsWith('.app') &&
    Number.isSafeInteger(value.sourcePid) &&
    Number(value.sourcePid) > 0 &&
    Number.isSafeInteger(value.sourceStartedAtMs) &&
    Number(value.sourceStartedAtMs) > 0 &&
    Number.isSafeInteger(value.monitorPid) &&
    Number(value.monitorPid) > 0 &&
    Number.isSafeInteger(value.monitorStartedAtMs) &&
    Number(value.monitorStartedAtMs) > 0 &&
    (value.phase === 'installing' || value.phase === 'failed') &&
    Number.isSafeInteger(value.createdAtMs) &&
    Number(value.createdAtMs) > 0 &&
    Number.isSafeInteger(value.heartbeatAtMs) &&
    Number(value.heartbeatAtMs) > 0 &&
    (value.failureReason === undefined ||
      (typeof value.failureReason === 'string' &&
        [
          'installer-exited-with-source-version',
          'installer-never-started',
          'install-timed-out'
        ].includes(value.failureReason))) &&
    (value.recoveryLaunchedAtMs === undefined || Number.isSafeInteger(value.recoveryLaunchedAtMs))
  )
}
