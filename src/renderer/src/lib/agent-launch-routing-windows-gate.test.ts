import { describe, expect, it } from 'vitest'
import { pathUsesWslUnc, readWorktreeUsesWslPath } from './agent-launch-routing-windows-gate'

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
