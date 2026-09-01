import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { app } from 'electron'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  MISSING_MANAGED_AUTH_MESSAGE,
  UNTRUSTED_MANAGED_AUTH_MESSAGE,
  type ClaudeManagedAuthVerdict
} from './claude-managed-auth-ownership'

export const MANAGED_AUTH_MARKER = '.orca-managed-claude-auth'

export function getClaudeManagedAccountsRoot(): string {
  return join(app.getPath('userData'), 'claude-accounts')
}

/**
 * Why a verdict rather than `string | null`: the previous catch-all turned a
 * transient `realpathSync`/`lstatSync` failure into the same null a stranger's
 * directory produces, and `cleanupFailedAdd` deleted the account on both
 * (STA-5674). Only a definitive absence or a completed observation may say
 * `untrusted`; an unreadable path is `indeterminate`.
 */
export function resolveClaudeManagedAuthVerdict(
  accountId: string,
  candidatePath: string,
  options: { adoptLegacyMarker?: boolean } = {}
): ClaudeManagedAuthVerdict {
  const resolvedCandidate = resolve(candidatePath)
  let canonicalCandidate: string
  try {
    // lstat before realpath: a symlinked candidate is a trust failure, not a
    // path to follow.
    if (lstatSync(resolvedCandidate).isSymbolicLink()) {
      return { kind: 'untrusted', reason: UNTRUSTED_MANAGED_AUTH_MESSAGE }
    }
    canonicalCandidate = realpathSync(resolvedCandidate)
  } catch (error) {
    return classifyReadFailure(error, MISSING_MANAGED_AUTH_MESSAGE)
  }
  let canonicalRoot: string
  try {
    canonicalRoot = realpathSync(getClaudeManagedAccountsRoot())
  } catch (error) {
    return classifyReadFailure(error, MISSING_MANAGED_AUTH_MESSAGE)
  }
  if (canonicalCandidate === canonicalRoot || !canonicalCandidate.startsWith(canonicalRoot + sep)) {
    return { kind: 'untrusted', reason: UNTRUSTED_MANAGED_AUTH_MESSAGE }
  }
  const relativePath = relative(canonicalRoot, canonicalCandidate)
  const relativeParts = relativePath.split(sep)
  if (
    relativePath.startsWith('..') ||
    relativeParts.length !== 2 ||
    relativeParts[0] !== accountId ||
    relativeParts[1] !== 'auth'
  ) {
    return { kind: 'untrusted', reason: UNTRUSTED_MANAGED_AUTH_MESSAGE }
  }
  return resolveMarkerVerdict(canonicalCandidate, accountId, options)
}

/**
 * The lossy view, for the read-only callers (rate-limit refresh, runtime
 * materialization) whose null means "skip this account" and which touch nothing
 * durable. Any caller that deletes or clears durable state must branch on
 * `resolveClaudeManagedAuthVerdict` instead — collapsing there is STA-5674.
 */
export function resolveOwnedClaudeManagedAuthPath(
  accountId: string,
  candidatePath: string,
  options: { adoptLegacyMarker?: boolean } = {}
): string | null {
  const verdict = resolveClaudeManagedAuthVerdict(accountId, candidatePath, options)
  return verdict.kind === 'owned' ? verdict.authPath : null
}

function classifyReadFailure(error: unknown, absenceReason: string): ClaudeManagedAuthVerdict {
  return isDefinitiveAbsence(error)
    ? { kind: 'untrusted', reason: absenceReason }
    : { kind: 'indeterminate', error }
}

type MarkerState = { kind: 'valid' | 'invalid' } | { kind: 'indeterminate'; error: unknown }

function resolveMarkerVerdict(
  canonicalCandidate: string,
  accountId: string,
  options: { adoptLegacyMarker?: boolean }
): ClaudeManagedAuthVerdict {
  const markerPath = join(canonicalCandidate, MANAGED_AUTH_MARKER)
  const marker = readMarkerState(markerPath, accountId)
  if (marker.kind !== 'invalid' || !options.adoptLegacyMarker) {
    return toMarkerVerdict(marker, canonicalCandidate)
  }
  try {
    writeFileSync(markerPath, `${accountId}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    // EEXIST means a marker is present but did not validate: a real trust
    // failure. Anything else is a write we could not complete.
    return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
      ? { kind: 'untrusted', reason: UNTRUSTED_MANAGED_AUTH_MESSAGE }
      : { kind: 'indeterminate', error }
  }
  return toMarkerVerdict(readMarkerState(markerPath, accountId), canonicalCandidate)
}

function toMarkerVerdict(
  marker: MarkerState,
  canonicalCandidate: string
): ClaudeManagedAuthVerdict {
  if (marker.kind === 'indeterminate') {
    return marker
  }
  return marker.kind === 'valid'
    ? { kind: 'owned', authPath: canonicalCandidate }
    : { kind: 'untrusted', reason: UNTRUSTED_MANAGED_AUTH_MESSAGE }
}

function readMarkerState(markerPath: string, accountId: string): MarkerState {
  let markerStats: ReturnType<typeof lstatSync>
  try {
    markerStats = lstatSync(markerPath)
  } catch (error) {
    // The marker is required, so its definitive absence is structural — but an
    // unreadable marker is not evidence of anything.
    return isDefinitiveAbsence(error) ? { kind: 'invalid' } : { kind: 'indeterminate', error }
  }
  if (markerStats.isSymbolicLink() || !markerStats.isFile()) {
    return { kind: 'invalid' }
  }
  try {
    return readFileSync(markerPath, 'utf-8').trim() === accountId
      ? { kind: 'valid' }
      : { kind: 'invalid' }
  } catch (error) {
    return isDefinitiveAbsence(error) ? { kind: 'invalid' } : { kind: 'indeterminate', error }
  }
}

export function readClaudeManagedAuthFile(
  managedAuthPath: string,
  filename: '.credentials.json' | 'oauth-account.json'
): string | null {
  const filePath = resolve(managedAuthPath, filename)
  try {
    if (!isOwnedChildFile(managedAuthPath, filePath)) {
      return null
    }
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

export function writeClaudeManagedAuthFile(
  managedAuthPath: string,
  filename: '.credentials.json' | 'oauth-account.json',
  contents: string
): void {
  const filePath = resolve(managedAuthPath, filename)
  if (existsSync(filePath) && !isOwnedChildFile(managedAuthPath, filePath)) {
    throw new Error('Managed Claude auth child file is not owned by Orca.')
  }
  writeFileAtomically(filePath, contents, { mode: 0o600 })
}

function isOwnedChildFile(managedAuthPath: string, filePath: string): boolean {
  if (
    !existsSync(filePath) ||
    lstatSync(filePath).isSymbolicLink() ||
    !lstatSync(filePath).isFile()
  ) {
    return false
  }
  const canonicalAuthPath = realpathSync(managedAuthPath)
  const canonicalFilePath = realpathSync(filePath)
  return canonicalFilePath.startsWith(canonicalAuthPath + sep)
}
