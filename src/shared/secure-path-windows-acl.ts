import { win32 as pathWin32 } from 'node:path'
import { runProcess, runProcessSync } from './child-process/run-process'
import { windowsSystem32Binary } from './child-process/windows-system-binary'

let cachedWindowsUserSid: string | null | undefined

const ACL_TIMEOUT_MS = 5000

/** SYSTEM and the local Administrators group: they can take ownership regardless, so denying them buys nothing. */
const LOCAL_SYSTEM_SID = 'S-1-5-18'
const BUILTIN_ADMINISTRATORS_SID = 'S-1-5-32-544'

type WindowsAclStep = {
  stage: 'reset' | 'grant' | 'verify'
  args: string[]
  /** Returns a failure reason, or null when the observed state is correct. */
  validate?: (stdout: string) => string | null
}

/**
 * Hardening a path is three `icacls` passes.
 *
 * `reset` drops every *explicit* ACE, which `/inheritance:r` alone leaves in place — a planted
 * `Everyone:(R)` survives the grant pass otherwise. It momentarily restores the inherited ACL,
 * which is the ACL the path already has when nothing has hardened it yet.
 *
 * `verify` re-reads the result. The predecessor had an equivalent check and it never ran, so a
 * loosened ACL went unreported for as long as the apply did; an apply that is not read back is
 * only half a control.
 */
function buildWindowsRestrictAclSteps(
  targetPath: string,
  currentUserSid: string,
  isDirectory: boolean
): WindowsAclStep[] {
  const icaclsPath = toIcaclsPath(targetPath)
  // Directories propagate to children (artifact-intent files rely on inheritance); files take no flags.
  const rights = isDirectory ? '(OI)(CI)(F)' : '(F)'
  const sids = [...new Set([currentUserSid, LOCAL_SYSTEM_SID, BUILTIN_ADMINISTRATORS_SID])]
  return [
    // Never add /c: it makes icacls exit 0 on "Failed processing 1 files", which is a silent no-op by another route.
    { stage: 'reset', args: [icaclsPath, '/reset', '/q'] },
    {
      stage: 'grant',
      args: [
        icaclsPath,
        '/inheritance:r',
        ...sids.flatMap((sid) => ['/grant:r', `*${sid}:${rights}`]),
        '/q'
      ]
    },
    {
      stage: 'verify',
      args: [icaclsPath],
      validate: (stdout) => validateAcl(stdout, icaclsPath, rights, sids.length)
    }
  ]
}

/**
 * Checks the applied DACL without depending on account-name resolution, which is localized.
 * The `(I)` inherited marker and the rights tokens are not.
 */
function validateAcl(
  stdout: string,
  icaclsPath: string,
  expectedRights: string,
  expectedCount: number
): string | null {
  const observed = parseIcaclsAceRights(stdout, icaclsPath)
  if (observed.length !== expectedCount) {
    return `expected ${expectedCount} access rules, found ${observed.length}`
  }
  if (observed.some((rights) => rights.includes('(I)'))) {
    return 'inherited access rules survived; the DACL is not protected'
  }
  const unexpected = observed.filter((rights) => rights !== expectedRights)
  if (unexpected.length > 0) {
    return `access rules do not grant ${expectedRights}: ${unexpected.join(' ')}`
  }
  return null
}

/**
 * Pulls the `(I)(F)`-style rights off each ACE line of `icacls <path>`.
 *
 * The first line carries the path, whose own characters must not be mistaken for an ACE, so it is
 * stripped by the exact string that was passed in. A blank line ends the list, before the
 * localized "Successfully processed" summary.
 */
function parseIcaclsAceRights(stdout: string, icaclsPath: string): string[] {
  const rights: string[] = []
  const lines = stdout.split(/\r?\n/)
  for (const [index, rawLine] of lines.entries()) {
    const line =
      index === 0 && rawLine.startsWith(icaclsPath) ? rawLine.slice(icaclsPath.length) : rawLine
    const trimmed = line.trim()
    if (!trimmed) {
      if (index === 0) {
        continue
      }
      break
    }
    const separator = trimmed.lastIndexOf(':(')
    if (separator !== -1) {
      rights.push(trimmed.slice(separator + 1))
    }
  }
  return rights
}

/**
 * icacls resolves through the MAX_PATH-limited API and fails with "cannot find the path
 * specified" past 259 characters; the extended prefix is the documented escape.
 */
function toIcaclsPath(targetPath: string): string {
  if (targetPath.length < 260 || targetPath.startsWith('\\\\?\\')) {
    return targetPath
  }
  const normalized = pathWin32.normalize(targetPath)
  if (/^[A-Za-z]:\\/.test(normalized)) {
    return `\\\\?\\${normalized}`
  }
  if (normalized.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${normalized.slice(2)}`
  }
  return targetPath
}

function icaclsProgram(): string {
  return windowsSystem32Binary('icacls.exe')
}

/**
 * Why loud: hardening stays best-effort — non-NTFS volumes, network paths and restricted tokens
 * fail legitimately and must not crash a write — but a swallowed failure leaves credentials under
 * inherited ACLs while every caller believes otherwise. Undetectable best-effort is not a control.
 */
function reportAclFailure(targetPath: string, stage: string, detail: string): void {
  console.warn('[secure-path.windows-acl] failed to restrict path', {
    targetPath,
    stage,
    detail: detail.trim().slice(0, 500)
  })
}

function checkAclStep(
  targetPath: string,
  step: WindowsAclStep,
  result: { code: number | null; stdout: string; stderr: string }
): boolean {
  if (result.code !== 0) {
    reportAclFailure(targetPath, step.stage, result.stderr || `icacls exited ${result.code}`)
    return false
  }
  const invalid = step.validate?.(result.stdout)
  if (invalid) {
    reportAclFailure(targetPath, step.stage, invalid)
    return false
  }
  return true
}

/**
 * Applies the ACL without blocking. `onSettled` reports the real outcome, which the caller needs
 * because the return value cannot: the cache must not keep claiming a path is hardened when the
 * apply that was supposed to harden it failed.
 */
export function bestEffortRestrictWindowsPath(
  targetPath: string,
  isDirectory: boolean,
  onSettled?: (restricted: boolean) => void
): void {
  const currentUserSid = getCurrentWindowsUserSid()
  if (!currentUserSid) {
    reportAclFailure(targetPath, 'sid-lookup', 'could not resolve the current user SID')
    onSettled?.(false)
    return
  }
  // Why async: hardening runs on the read path, and blocking it on a spawn stormed the main thread (#4901).
  void runRestrictAclStepsAsync(
    targetPath,
    buildWindowsRestrictAclSteps(targetPath, currentUserSid, isDirectory)
  ).then(onSettled)
}

async function runRestrictAclStepsAsync(
  targetPath: string,
  steps: readonly WindowsAclStep[]
): Promise<boolean> {
  for (const step of steps) {
    try {
      const result = await runProcess({
        program: icaclsProgram(),
        args: step.args,
        timeoutMs: ACL_TIMEOUT_MS
      })
      if (!checkAclStep(targetPath, step, result)) {
        return false
      }
    } catch (error) {
      reportAclFailure(targetPath, step.stage, String(error))
      return false
    }
  }
  return true
}

export function restrictWindowsPathSync(targetPath: string, isDirectory: boolean): boolean {
  const currentUserSid = getCurrentWindowsUserSid()
  if (!currentUserSid) {
    reportAclFailure(targetPath, 'sid-lookup', 'could not resolve the current user SID')
    return false
  }
  // Why sync: the file must not be published until its ACL is actually restricted (read path stays async, #4901).
  for (const step of buildWindowsRestrictAclSteps(targetPath, currentUserSid, isDirectory)) {
    try {
      const result = runProcessSync({
        program: icaclsProgram(),
        args: step.args,
        timeoutMs: ACL_TIMEOUT_MS
      })
      if (!checkAclStep(targetPath, step, result)) {
        return false
      }
    } catch (error) {
      // Why not fatal: a failed ACL apply must not crash the write; false leaves the path uncached to retry later.
      reportAclFailure(targetPath, step.stage, String(error))
      return false
    }
  }
  return true
}

function getCurrentWindowsUserSid(): string | null {
  if (cachedWindowsUserSid !== undefined) {
    return cachedWindowsUserSid
  }
  try {
    const result = runProcessSync({
      program: windowsSystem32Binary('whoami.exe'),
      args: ['/user', '/fo', 'csv', '/nh'],
      timeoutMs: ACL_TIMEOUT_MS
    })
    const columns = parseCsvLine(result.stdout.trim())
    cachedWindowsUserSid = result.code === 0 ? (columns[1] ?? null) : null
  } catch {
    cachedWindowsUserSid = null
  }
  return cachedWindowsUserSid
}

function parseCsvLine(line: string): string[] {
  return line.split(/","/).map((part) => part.replace(/^"/, '').replace(/"$/, ''))
}

export function resetSecureFileWindowsUserSidForTests(): void {
  cachedWindowsUserSid = undefined
}
