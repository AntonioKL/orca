import { describe, it, expect } from 'vitest'
import { resolveWorktreeDisplayNameMode } from './worktree-display-name-mode'

describe('resolveWorktreeDisplayNameMode', () => {
  it('prefers the recorded flag over the stored name', () => {
    expect(
      resolveWorktreeDisplayNameMode({
        displayName: 'Fix auth',
        displayNameIsPinned: true
      })
    ).toBe('fixed')
    expect(
      resolveWorktreeDisplayNameMode({
        displayName: 'Fix auth',
        displayNameIsPinned: false
      })
    ).toBe('automatic')
  })

  it('leaves rows written before the flag existed on their original behavior', () => {
    expect(resolveWorktreeDisplayNameMode({ displayName: 'Fix auth' })).toBe('fixed')
    expect(resolveWorktreeDisplayNameMode({ displayName: '   ' })).toBe('automatic')
    expect(resolveWorktreeDisplayNameMode({})).toBe('automatic')
    expect(resolveWorktreeDisplayNameMode(undefined)).toBe('automatic')
  })
})
