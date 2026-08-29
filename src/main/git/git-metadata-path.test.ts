import { describe, expect, it } from 'vitest'
import { resolveGitMetadataPath } from './git-metadata-path'

describe('resolveGitMetadataPath', () => {
  it('maps a WSL drive mount without requiring a distro', () => {
    expect(
      resolveGitMetadataPath(
        String.raw`C:\Users\me\repo`,
        '/mnt/c/Users/me/repo/.git/worktrees/feature',
        { platform: 'win32' }
      )
    ).toBe(String.raw`C:\Users\me\repo\.git\worktrees\feature`)
  })

  it('maps an absolute distro path with the runtime distro', () => {
    expect(
      resolveGitMetadataPath(String.raw`C:\Users\me\repo`, '/home/me/repo/.git/worktrees/feature', {
        platform: 'win32',
        wslDistro: 'Ubuntu'
      })
    ).toBe(String.raw`\\wsl.localhost\Ubuntu\home\me\repo\.git\worktrees\feature`)
  })

  it('prefers the distro encoded by a WSL UNC base path', () => {
    expect(
      resolveGitMetadataPath(
        String.raw`\\wsl.localhost\Debian\home\me\repo`,
        '/home/me/repo/.git/worktrees/feature',
        { platform: 'win32', wslDistro: 'Ubuntu' }
      )
    ).toBe(String.raw`\\wsl.localhost\Debian\home\me\repo\.git\worktrees\feature`)
  })

  it('rejects an untranslatable POSIX absolute path on native Windows', () => {
    expect(
      resolveGitMetadataPath(String.raw`C:\Users\me\repo`, '/home/me/repo/.git', {
        platform: 'win32'
      })
    ).toBeNull()
  })

  it.each([
    ['/var/lib/git/worktrees/feature', '/var/lib/git/worktrees/feature', 'linux'],
    [String.raw`D:\repo\.git`, String.raw`D:\repo\.git`, 'win32'],
    [String.raw`\\server\share\repo\.git`, String.raw`\\server\share\repo\.git`, 'win32']
  ] as const)('preserves an absolute metadata path %s', (metadataPath, expected, platform) => {
    expect(resolveGitMetadataPath('/repo', metadataPath, { platform })).toBe(expected)
  })

  it.each(['', '   ', '\t'])('rejects an empty metadata path', (metadataPath) => {
    expect(resolveGitMetadataPath('/repo', metadataPath, { platform: 'linux' })).toBeNull()
  })

  it('resolves relative paths using the base path flavor', () => {
    expect(
      resolveGitMetadataPath('/repo/worktree', '../.git/worktrees/feature', {
        platform: 'linux'
      })
    ).toBe('/repo/.git/worktrees/feature')
    expect(
      resolveGitMetadataPath(String.raw`C:\repo\worktree`, String.raw`..\.git\worktrees\feature`, {
        platform: 'win32'
      })
    ).toBe(String.raw`C:\repo\.git\worktrees\feature`)
  })
})
