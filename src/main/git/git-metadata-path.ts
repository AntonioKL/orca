import { posix, win32 } from 'node:path'
import { parseWslUncPath, toWindowsWslDrivePath, toWindowsWslPath } from '../../shared/wsl-paths'

export type GitMetadataPathOptions = {
  platform?: NodeJS.Platform
  wslDistro?: string
}

export function resolveGitMetadataPath(
  basePath: string,
  rawPath: string,
  options: GitMetadataPathOptions = {}
): string | null {
  const value = rawPath.trim()
  const platform = options.platform ?? process.platform
  if (!value) {
    return null
  }
  if (isWindowsDriveOrUncPath(value)) {
    return value
  }
  if (!value.startsWith('/')) {
    return pathOperations(platform).resolve(basePath, value)
  }
  if (platform !== 'win32') {
    return value
  }

  const drivePath = toWindowsWslDrivePath(value)
  if (drivePath) {
    return drivePath
  }
  const distro = parseWslUncPath(basePath)?.distro ?? options.wslDistro?.trim()
  return distro ? toWindowsWslPath(value, distro) : null
}

function isWindowsDriveOrUncPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(value)
}

function pathOperations(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}
