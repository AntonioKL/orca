// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import {
  pathUsesWslUnc,
  readAgentLaunchHostPlatform,
  readWorktreeUsesWslPath
} from './agent-launch-routing-windows-gate'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'

afterEach(() => {
  setLocalRuntimeCapabilitiesForTests([])
  delete (window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
})

describe('readAgentLaunchHostPlatform', () => {
  it('uses the execution host instead of the browser platform for paired web', () => {
    ;(window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    setLocalRuntimeCapabilitiesForTests([], 'linux')

    expect(readAgentLaunchHostPlatform('win32')).toBe('linux')

    setLocalRuntimeCapabilitiesForTests([], 'win32')
    expect(readAgentLaunchHostPlatform('darwin')).toBe('win32')
  })

  it('fails closed while a paired execution host platform is unknown', () => {
    ;(window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true

    expect(readAgentLaunchHostPlatform('linux')).toBeNull()
  })

  it('uses the renderer platform for a local desktop runtime', () => {
    expect(readAgentLaunchHostPlatform('darwin')).toBe('darwin')
  })
})

describe('pathUsesWslUnc', () => {
  it('treats a wsl.localhost parent as WSL', () => {
    expect(pathUsesWslUnc(String.raw`\\wsl.localhost\Ubuntu\home\dev`)).toBe(true)
  })

  it('treats a legacy wsl$ parent as WSL', () => {
    expect(pathUsesWslUnc(String.raw`\\wsl$\Ubuntu\home\dev`)).toBe(true)
  })

  it('treats a native Windows parent as not WSL', () => {
    expect(pathUsesWslUnc('C:\\projects')).toBe(false)
  })

  it('treats an absent parent as not WSL', () => {
    expect(pathUsesWslUnc(null)).toBe(false)
    expect(pathUsesWslUnc(undefined)).toBe(false)
  })
})

describe('readWorktreeUsesWslPath', () => {
  // An unhydrated store must read as "not WSL" rather than throwing on the
  // launch path; this threw before the collections were defaulted.
  it('does not throw when the store has not hydrated its collections', () => {
    expect(() => readWorktreeUsesWslPath({}, 'wt-1')).not.toThrow()
    expect(readWorktreeUsesWslPath({}, 'wt-1')).toBe(false)
  })

  it('reports a folder workspace on a WSL UNC path', () => {
    expect(
      readWorktreeUsesWslPath(
        {
          folderWorkspaces: [
            { id: 'f1', folderPath: String.raw`\\wsl.localhost\Ubuntu\home\dev\repo` }
          ] as never,
          worktreesByRepo: {}
        },
        'folder:f1'
      )
    ).toBe(true)
  })
})
