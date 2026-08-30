import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  hasAppImageRuntimeEnvironment,
  resolveAppImageRuntimeIdentity
} from '../appimage-runtime-identity'
import { getAppImageCacheRootPath } from './appimage-extracted-root'
import { publishAppImageLauncherEndpoint } from './appimage-stable-launcher'
import { getBundledLauncherPath } from './bundled-cli-launcher-path'
import { buildBareOrcaCliScript } from './linux-bare-orca-dispatcher'

const SHIM_DIR_NAME = 'linux-orca-cli-shim'

export type LinuxTerminalOrcaCliShimOptions = {
  userDataPath: string
  /** Test seam — defaults to the packaged resources root. */
  resourcesPath?: string | null
  /** Trusted caller override; production requires the complete AppImage runtime identity. */
  appImagePath?: string | null
  /** Test seam — defaults to $XDG_CACHE_HOME/orca/appimage. */
  appImageCacheRootPath?: string
}

// Why: on Linux the CLI installs as `orca-ide` so it never shadows the GNOME
// Orca screen reader at /usr/bin/orca — but agent-facing surfaces (skills,
// dispatch preambles, CLI hints) all invoke bare `orca`, so on stock Ubuntu an
// agent inside an Orca terminal would launch the screen reader instead
// (stablyai/orca#7904). Prepending this userData-scoped shim dir to managed-PTY
// PATH makes bare `orca` resolve to the Orca CLI inside Orca terminals only,
// leaving the user's own shells (and their screen reader) untouched.
export function ensureLinuxTerminalOrcaCliShimDir(
  options: LinuxTerminalOrcaCliShimOptions
): string | null {
  const resourcesPath =
    options.resourcesPath === undefined ? process.resourcesPath : options.resourcesPath
  const hasExplicitAppImagePath = Object.hasOwn(options, 'appImagePath')
  const runtimeIdentity = resolveAppImageRuntimeIdentity({ resourcesPath })
  if (!hasExplicitAppImagePath && hasAppImageRuntimeEnvironment() && !runtimeIdentity) {
    return null
  }
  const appImagePath = hasExplicitAppImagePath
    ? (options.appImagePath ?? null)
    : (runtimeIdentity?.appImagePath ?? null)
  if (appImagePath) {
    return ensureAppImageShim(options, resourcesPath)
  }

  if (!resourcesPath) {
    return null
  }
  const launcherPath = getBundledLauncherPath('linux', resourcesPath)
  return launcherPath && existsSync(launcherPath)
    ? ensureShimForLauncher(options.userDataPath, launcherPath)
    : null
}

function ensureAppImageShim(
  options: LinuxTerminalOrcaCliShimOptions,
  resourcesPath: string | null
): string | null {
  if (!resourcesPath) {
    return null
  }
  const liveLauncherPath = getBundledLauncherPath('linux', resourcesPath)
  if (!liveLauncherPath || !existsSync(liveLauncherPath)) {
    return null
  }
  const stableLauncherPath = publishAppImageLauncherEndpoint(
    options.appImageCacheRootPath ?? getAppImageCacheRootPath(),
    'live',
    liveLauncherPath
  )
  return stableLauncherPath ? ensureShimForLauncher(options.userDataPath, stableLauncherPath) : null
}

function ensureShimForLauncher(userDataPath: string, launcherPath: string): string | null {
  const script = buildBareOrcaCliScript(launcherPath)

  const shimDir = join(userDataPath, SHIM_DIR_NAME)
  const shimPath = join(shimDir, 'orca')
  try {
    if (readShim(shimPath) !== script) {
      mkdirSync(shimDir, { recursive: true })
      writeFileSync(shimPath, script, 'utf8')
    }
    chmodSync(shimPath, 0o755)
  } catch {
    return null
  }
  return shimDir
}

function readShim(shimPath: string): string | null {
  try {
    return readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }
}
