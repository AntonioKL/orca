import { join } from 'node:path'

/**
 * Where an agent CLI lands when no version manager installed it: Homebrew (both
 * prefixes), npm's default global prefix, snap, nix, or the CLI's own installer
 * (#829 named `~/.opencode/bin` as the motivating case, but only for the
 * login-shell probe; the fallback used when that probe fails never gained it).
 *
 * The same set `patchPackagedProcessPath` appends to PATH, minus the sbin dirs
 * and the generic `~/bin` — no agent CLI installer targets those. Kept in step
 * with it and with `POSIX_VERSION_MANAGER_BIN_DIRS`, or the answer to "is this
 * agent installed?" depends on which of the three lists ran.
 *
 * Lookup-only, deliberately outside `getBaseVersionManagerDirectories`: that
 * list is PREPENDED to PATH by `getVersionManagerBinPaths` callers, and hoisting
 * a system dir over the inherited PATH re-ranks binaries the user already has
 * (#18234).
 */
export function getSystemCliInstallDirectories(
  platform: NodeJS.Platform,
  homePath: string
): string[] {
  if (platform === 'win32') {
    return []
  }
  const directories = [join(homePath, '.opencode', 'bin')]
  if (platform === 'darwin') {
    // Apple Silicon Homebrew; Intel Homebrew shares /usr/local with npm's prefix.
    directories.push('/opt/homebrew/bin')
  } else {
    // Linuxbrew uses its own prefix, not /opt/homebrew; snap is Linux-only.
    directories.push('/home/linuxbrew/.linuxbrew/bin', '/snap/bin')
  }
  directories.push(
    '/usr/local/bin',
    '/nix/var/nix/profiles/default/bin',
    join(homePath, '.nix-profile', 'bin')
  )
  return directories
}
