import { describe, expect, it } from 'vitest'
import { formatGitObjectStoreFailureMessage } from '../../../shared/git-object-store-failure'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from './workspace-create-error-format'

describe('formatWorkspaceCreateError', () => {
  it('returns guidance for missing default base ref failures', () => {
    const error = new Error(
      'Could not resolve a default base ref for this repo. Pick a base branch explicitly and try again.'
    )

    const formatted = formatWorkspaceCreateError(error)

    expect(formatted).toEqual({
      title: 'No base branch found',
      message: 'Orca could not resolve a usable base ref for this workspace.',
      help: 'Create an initial commit (for example on main), or select an existing branch in Create From, then try again.'
    })
    expect(getWorkspaceCreateErrorToastMessage(formatted)).toBe('No base branch found')
  })

  it('matches missing base ref failures case-insensitively', () => {
    const formatted = formatWorkspaceCreateError(
      new Error('COULD NOT RESOLVE A DEFAULT BASE REF from remote provider')
    )

    expect(formatted.title).toBe('No base branch found')
    expect(formatted.help).toBeDefined()
  })

  it('redacts a raw leaked worktree-add failure from an older host', () => {
    // Pre-fix hosts (and older relays) rethrow git's message verbatim through Electron.
    const formatted = formatWorkspaceCreateError(
      new Error(
        "Error invoking remote method 'worktrees:create': Error: Command failed: " +
          "git worktree add /Users/akulafb/dev/worktrees/test 'akulafb/test'\n" +
          'fatal: unable to read tree (041335168f0214913840aaaaaaaaaaaaaaaaaaaa)'
      )
    )

    expect(formatted.title).toBe('Repository objects are missing')
    expect(formatted.message).not.toContain('/Users/akulafb')
    expect(formatted.message).not.toContain('git worktree add')
    expect(formatted.message).not.toContain('Error invoking remote method')
    expect(formatted.help).toContain('git fsck')
    expect(getWorkspaceCreateErrorToastMessage(formatted)).toBe('Repository objects are missing')
  })

  it("redacts the sparse path's checkout failure, which names no path in git's own wording", () => {
    // Verbatim git 2.44.0 stderr for a sparse create whose root tree is gone; the leak is
    // the argv line execFile prepends, which carries the branch the user typed.
    const formatted = formatWorkspaceCreateError(
      new Error(
        "Error invoking remote method 'worktrees:create': Error: Command failed: " +
          'git checkout akulafb/test\n' +
          'fatal: unable to parse commit 435b1d6c622920a72b8984ec55742106c5434436'
      )
    )

    expect(formatted.title).toBe('Repository objects are missing')
    expect(formatted.message).toContain(
      'unable to parse commit 435b1d6c622920a72b8984ec55742106c5434436'
    )
    // Nothing was probed on this side, so no claim about which object is gone.
    expect(formatted.message).not.toContain('root tree object is missing')
    expect(formatted.message).not.toContain('Command failed')
    expect(formatted.message).not.toContain('git checkout')
    expect(formatted.help).toContain('git fsck')
  })

  it('keeps the rollback cleanup note the host appended after the repair guidance', () => {
    const diagnosed = formatGitObjectStoreFailureMessage({
      failure: { kind: 'unparsable-commit', oid: '435b1d6c622920a72b8984ec55742106c5434436' },
      branch: 'akulafb/test',
      commit: 'present',
      rootTree: 'missing',
      partialClone: 'no'
    })

    const formatted = formatWorkspaceCreateError(
      new Error(
        `${diagnosed} (cleanup also failed — the partially created worktree at "/Users/akulafb/dev/worktrees/test" may need manual removal)`
      )
    )

    expect(formatted.message).not.toContain('may need manual removal')
    expect(formatted.help).toContain('may need manual removal')
  })

  it('keeps the diagnosed message the host already composed', () => {
    const hostMessage = formatGitObjectStoreFailureMessage({
      failure: { kind: 'unreadable-tree', oid: '041335168f0214913840aaaaaaaaaaaaaaaaaaaa' },
      branch: 'akulafb/test',
      commit: 'present',
      rootTree: 'missing',
      partialClone: 'no'
    })

    const formatted = formatWorkspaceCreateError(new Error(hostMessage))

    expect(formatted.title).toBe('Repository objects are missing')
    expect(formatted.message).toContain('root tree object is missing')
    expect(formatted.message).not.toContain('Error invoking remote method')
    // Repair guidance moves into help so the toast stays short.
    expect(formatted.message).not.toContain('git fsck')
    expect(formatted.help).toContain('git fsck')
    expect(getWorkspaceCreateErrorToastMessage(formatted)).toBe('Repository objects are missing')
  })

  it('strips the IPC envelope from a diagnosed message a modern host composed', () => {
    // Electron's ipcRenderer.invoke prefixes every rejection it forwards; the host text is intact behind it.
    const hostMessage = formatGitObjectStoreFailureMessage({
      failure: { kind: 'unreadable-tree', oid: '041335168f0214913840aaaaaaaaaaaaaaaaaaaa' },
      branch: 'akulafb/test',
      commit: 'present',
      rootTree: 'missing',
      partialClone: 'no'
    })

    const formatted = formatWorkspaceCreateError(
      new Error(`Error invoking remote method 'worktrees:create': Error: ${hostMessage}`)
    )

    expect(formatted.message).not.toContain('Error invoking remote method')
    expect(formatted.message.startsWith('Orca could not create this workspace')).toBe(true)
    expect(formatted.message).toContain('root tree object is missing')
    expect(formatted.help).toContain('git fsck')
  })

  it('strips the IPC envelope even when a newer host worded the diagnosis its own way', () => {
    const formatted = formatWorkspaceCreateError(
      new Error(
        "Error invoking remote method 'worktrees:create': Error: Future host wording: the repository object database is missing objects."
      )
    )

    expect(formatted.message).not.toContain('Error invoking remote method')
    expect(formatted.message).toContain('Future host wording')
  })

  it('still surfaces repair guidance when a newer host worded its own tail differently', () => {
    const formatted = formatWorkspaceCreateError(
      new Error(
        'Orca could not create this workspace because the repository object database is missing objects. Some future wording.'
      )
    )

    expect(formatted.title).toBe('Repository objects are missing')
    expect(formatted.message).toContain('Some future wording.')
    expect(formatted.help).toContain('git fsck')
  })

  it('passes unknown errors through unchanged', () => {
    const formatted = formatWorkspaceCreateError(new Error('fatal: not a git repository'))

    expect(formatted).toEqual({
      title: 'fatal: not a git repository',
      message: 'fatal: not a git repository'
    })
    expect(getWorkspaceCreateErrorToastMessage(formatted)).toBe('fatal: not a git repository')
  })
})
