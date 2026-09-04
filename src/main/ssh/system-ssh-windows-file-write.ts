import { randomBytes } from 'node:crypto'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import { normalizeWindowsRemotePath } from './ssh-remote-platform'

/**
 * Suffix marking the path a Windows write lands on before it is published by rename.
 *
 * The random tail is the fix for a measured harm, not decoration. A write that loses contact with
 * the host leaves a remote process that may still hold the staging file open exclusively, and
 * `docs/reference/ssh-execution-boundary.md` is explicit that losing contact is not evidence that
 * process died — so the retry must not reuse the name it may still own. A fresh name per attempt
 * means a retry never meets its predecessor's lock; the abandoned file is cleaned up best-effort
 * and never treated as proof of anything.
 */
export const WINDOWS_STAGED_WRITE_SUFFIX = '.orca-partial'

export function makeWindowsStagingPath(remotePath: string): string {
  return `${remotePath}${WINDOWS_STAGED_WRITE_SUFFIX}-${randomBytes(6).toString('hex')}`
}

export type WindowsPublishMode = 'create' | 'exclusive' | 'append'

/**
 * Publishes a staged upload onto its real name.
 *
 * Every branch reads the staged *file*, never a redirected stdin, which is what makes this safe on
 * a host whose Windows PowerShell 5.1 cannot drain a piped stdin. `File::Move` throws when the
 * destination exists, which is exactly the exclusive contract; the replacing caller deletes first
 * (a no-op on an absent path).
 */
export function makeWindowsPublishStagedFileCommand(
  stagingPath: string,
  remotePath: string,
  mode: WindowsPublishMode
): string {
  const preamble = [
    '$ErrorActionPreference = "Stop"',
    `$staging = ${powerShellLiteral(stagingPath)}`,
    `$path = ${powerShellLiteral(remotePath)}`,
    '$parent = [System.IO.Path]::GetDirectoryName($path)',
    'if ($parent) { $null = [System.IO.Directory]::CreateDirectory($parent) }'
  ]
  if (mode === 'append') {
    return powerShellCommand(
      [
        ...preamble,
        '$in = [System.IO.File]::OpenRead($staging)',
        '$out = [System.IO.File]::Open($path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)',
        'try { $in.CopyTo($out) } finally { $out.Dispose(); $in.Dispose() }',
        '[System.IO.File]::Delete($staging)'
      ].join('; ')
    )
  }
  return powerShellCommand(
    [
      ...preamble,
      ...(mode === 'exclusive' ? [] : ['[System.IO.File]::Delete($path)']),
      '[System.IO.File]::Move($staging, $path)'
    ].join('; ')
  )
}

/** Best-effort removal of a staged file whose write was abandoned. Never asserts the writer died. */
export function makeWindowsDiscardStagedFileCommand(stagingPath: string): string {
  return powerShellCommand(
    [
      // Deliberately not `Stop`: the previous writer may still hold this file, and that is a
      // possibility to tolerate, not an error to report. The unique staging name means a leftover
      // blocks nothing; sweeping it is housekeeping.
      '$ErrorActionPreference = "SilentlyContinue"',
      `$staging = ${powerShellLiteral(stagingPath)}`,
      '[System.IO.File]::Delete($staging)'
    ].join('; ')
  )
}

/**
 * The ancestor directories of a Windows remote path, drive root first.
 *
 * sftp's `mkdir` creates one level, so a batch has to name each level itself. The drive root is
 * excluded: `-mkdir "/C:/"` is not a directory anyone creates.
 */
export function windowsRemoteAncestorDirectories(remotePath: string): string[] {
  const normalized = normalizeWindowsRemotePath(remotePath)
  const segments = normalized.split('/')
  segments.pop()
  const ancestors: string[] = []
  // Start past the drive (`C:`) or the UNC host, which are never created.
  for (let depth = 2; depth <= segments.length; depth += 1) {
    const directory = segments.slice(0, depth).join('/')
    if (directory) {
      ancestors.push(directory)
    }
  }
  return ancestors
}

/**
 * `[Console]::OpenStandardInput()` into a `FileStream`, used only by the two stdin fallbacks.
 *
 * On Windows PowerShell 5.1 this is the defective read; see the strategy comment in
 * `system-ssh-file-binary-transfer.ts`. It is correct under PowerShell 7.
 */
export function makeWindowsWriteFileCommand(
  remotePath: string,
  options?: { append?: boolean; exclusive?: boolean; executable?: 'powershell.exe' | 'pwsh.exe' }
): string {
  const fileMode = options?.append ? 'Append' : options?.exclusive ? 'CreateNew' : 'Create'
  return powerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      `$path = ${powerShellLiteral(remotePath)}`,
      '$parent = [System.IO.Path]::GetDirectoryName($path)',
      'if ($parent) { $null = [System.IO.Directory]::CreateDirectory($parent) }',
      '$inputStream = [Console]::OpenStandardInput()',
      `$outputStream = [System.IO.File]::Open($path, [System.IO.FileMode]::${fileMode}, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)`,
      'try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }'
    ].join('; '),
    options?.executable ?? 'powershell.exe'
  )
}
