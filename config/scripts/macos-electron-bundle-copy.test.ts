import { describe, expect, it, vi } from 'vitest'
import {
  MACOS_ELECTRON_CLONE_ARGS,
  cloneElectronBundleWithCp,
  copyMacElectronBundle
} from './macos-electron-bundle-copy.mjs'

describe('macos-electron-bundle-copy', () => {
  it('uses the APFS clone path on macOS', () => {
    const clone = vi.fn()
    const copy = vi.fn()

    const result = copyMacElectronBundle('/source/Electron.app', '/dest/Orca.app', {
      platform: 'darwin',
      clone,
      copy
    })

    expect(result).toEqual({ usedClone: true, cloneError: null })
    expect(clone).toHaveBeenCalledOnce()
    expect(clone).toHaveBeenCalledWith('/source/Electron.app', '/dest/Orca.app')
    expect(copy).not.toHaveBeenCalled()
  })

  it('removes a partial clone and falls back to a regular copy', () => {
    const cloneError = new Error('clonefile is unavailable')
    const clone = vi.fn(() => {
      throw cloneError
    })
    const removePartial = vi.fn()
    const copy = vi.fn()

    const result = copyMacElectronBundle('/source/Electron.app', '/dest/Orca.app', {
      platform: 'darwin',
      clone,
      removePartial,
      copy
    })

    expect(result).toEqual({ usedClone: false, cloneError })
    expect(removePartial).toHaveBeenCalledOnce()
    expect(removePartial).toHaveBeenCalledWith('/dest/Orca.app')
    expect(copy).toHaveBeenCalledOnce()
    expect(copy).toHaveBeenCalledWith('/source/Electron.app', '/dest/Orca.app')
  })

  it('uses the regular copy path off macOS without attempting a clone', () => {
    const clone = vi.fn()
    const copy = vi.fn()

    const result = copyMacElectronBundle('/source/Electron.app', '/dest/Orca.app', {
      platform: 'linux',
      clone,
      copy
    })

    expect(result).toEqual({ usedClone: false, cloneError: null })
    expect(clone).not.toHaveBeenCalled()
    expect(copy).toHaveBeenCalledWith('/source/Electron.app', '/dest/Orca.app')
  })

  it('invokes BSD cp with clone and symlink-preserving flags', () => {
    const execFile = vi.fn()

    cloneElectronBundleWithCp('/source/Electron.app', '/dest/Orca.app', { execFile })

    expect(execFile).toHaveBeenCalledWith(
      '/bin/cp',
      [...MACOS_ELECTRON_CLONE_ARGS, '/source/Electron.app', '/dest/Orca.app'],
      { stdio: 'ignore' }
    )
  })

  it('does not hide a regular-copy failure after clone cleanup', () => {
    const cloneError = new Error('clonefile is unavailable')
    const copyError = new Error('destination is not writable')
    const copy = vi.fn(() => {
      throw copyError
    })

    expect(() =>
      copyMacElectronBundle('/source/Electron.app', '/dest/Orca.app', {
        platform: 'darwin',
        clone: () => {
          throw cloneError
        },
        copy
      })
    ).toThrow(copyError)
  })
})
