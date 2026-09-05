import { describe, expect, it } from 'vitest'
import { worktreeCheckoutGitArgs } from './worktree-checkout-config'

describe('worktree checkout concurrency', () => {
  it('bounds native Mac checkout workers without changing other execution hosts', () => {
    expect(worktreeCheckoutGitArgs({}, 'darwin')).toEqual(['-c', 'checkout.workers=4'])
    expect(worktreeCheckoutGitArgs({ wslDistro: 'Ubuntu' }, 'darwin')).toEqual([])
    expect(worktreeCheckoutGitArgs({}, 'win32')).toEqual([])
    expect(worktreeCheckoutGitArgs({ wslDistro: 'Ubuntu' }, 'win32')).toEqual([])
    expect(worktreeCheckoutGitArgs({}, 'linux')).toEqual([])
  })
})
