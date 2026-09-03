import { join } from 'node:path'

/**
 * Where an agent CLI lands when no version manager installed it: Homebrew (both
 * prefixes), npm's default global prefix, snap, nix, or the CLI's own installer
 * (#829 named `~/.opencode/bin` as the motivating case, but only for the
 * login-shell probe; the fallback used when that probe fails never gained it).
 *
 * Ordered to match what `patchPackagedProcessPath` appends to PATH, so a CLI
 * present in two of these dirs resolves to the same binary here, in the packaged
 * PATH scan, and in `POSIX_VERSION_MANAGER_BIN_DIRS`. Three deliberate gaps vs
 * that seed: the `sbin` dirs and the generic `~/bin` / `~/.local/bin` (no agent
 * CLI installer targets those, and `~/.local/bin` is already a version-manager
 * dir here); `~/.vite-plus/bin`, which no probed agent command maps to; and
 * `/opt/homebrew` off darwin, since a Linux box's brew prefix is Linuxbrew's.
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
  // Why nothing here: the PATH seed's system block is POSIX-only too, so
  // Windows installs outside a version manager (`%USERPROFILE%\.opencode\bin`)
  // have never had install-dir coverage in either list. Unchanged, not fixed.
  if (platform === 'win32') {
    return []
  }
  const directories: string[] = []
  if (platform === 'darwin') {
    // Apple Silicon Homebrew; Intel Homebrew shares /usr/local with npm's prefix.
    directories.push('/opt/homebrew/bin')
  }
  directories.push('/usr/local/bin')
  if (platform !== 'darwin') {
    // Linuxbrew uses its own prefix, not /opt/homebrew; snap is Linux-only.
    directories.push('/snap/bin', '/home/linuxbrew/.linuxbrew/bin')
  }
  directories.push(
    '/nix/var/nix/profiles/default/bin',
    join(homePath, '.nix-profile', 'bin'),
    join(homePath, '.opencode', 'bin')
  )
  return directories
}
