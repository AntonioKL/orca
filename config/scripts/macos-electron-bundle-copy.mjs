import { execFileSync } from 'node:child_process'
import { cpSync, rmSync } from 'node:fs'

const MACOS_CP = '/bin/cp'
export const MACOS_ELECTRON_CLONE_ARGS = Object.freeze(['-c', '-R', '-P'])

/**
 * Copy an Electron.app with an APFS clone when the host supports it.
 *
 * Electron's macOS bundle is large, while the dev runner only changes a few
 * metadata files before signing. APFS clones keep the framework files shared
 * until one of those files is changed. Other platforms, and filesystems where
 * clonefile is unavailable, use the existing regular copy path.
 */
export function copyMacElectronBundle(sourcePath, destinationPath, options = {}) {
  const platform = options.platform ?? process.platform
  const copy = options.copy ?? copyElectronBundleNormally

  if (platform !== 'darwin') {
    copy(sourcePath, destinationPath)
    return { usedClone: false, cloneError: null }
  }

  const clone = options.clone ?? cloneElectronBundleWithCp
  const removePartial = options.removePartial ?? removePartialBundle

  try {
    clone(sourcePath, destinationPath)
    return { usedClone: true, cloneError: null }
  } catch (cloneError) {
    // cp may have created part of the destination before discovering that the
    // filesystem cannot clone. Remove only that fresh destination, then retry
    // with the same copy semantics as the pre-clone runner.
    try {
      removePartial(destinationPath)
    } catch {
      // The regular copy below reports the actionable failure if cleanup did not
      // succeed; do not hide it behind a best-effort cleanup error.
    }
    console.warn('[orca-dev] APFS clone unavailable; using regular copy')
    copy(sourcePath, destinationPath)
    return { usedClone: false, cloneError }
  }
}

export function cloneElectronBundleWithCp(sourcePath, destinationPath, options = {}) {
  const execFile = options.execFile ?? execFileSync
  execFile(MACOS_CP, [...MACOS_ELECTRON_CLONE_ARGS, sourcePath, destinationPath], {
    stdio: 'ignore'
  })
}

function copyElectronBundleNormally(sourcePath, destinationPath) {
  cpSync(sourcePath, destinationPath, { recursive: true, verbatimSymlinks: true })
}

function removePartialBundle(destinationPath) {
  rmSync(destinationPath, { recursive: true, force: true })
}
