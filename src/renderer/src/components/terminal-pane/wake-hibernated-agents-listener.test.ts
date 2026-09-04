// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'
import { installWakeHibernatedAgentsListener } from './wake-hibernated-agents-listener'

function dispatchWake(detail: WakeHibernatedAgentsWorktreeDetail): void {
  window.dispatchEvent(
    new CustomEvent<WakeHibernatedAgentsWorktreeDetail>(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, {
      detail
    })
  )
}

describe('installWakeHibernatedAgentsListener', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.()
    }
  })

  function install(binding: {
    dispose?: () => void
    wakeHibernatedAgentIfArmed?: (claimed?: Set<string>) => string | null
  }): void {
    cleanups.push(
      installWakeHibernatedAgentsListener({
        worktreeId: 'wt-1',
        tabId: 'tab-a',
        getPanePtyBindings: () => [{ dispose: () => {}, ...binding }]
      })
    )
  }

  // Why this test exists: the dispatcher uses the shared event constant, and a
  // refactor once re-registered the listener under an inlined near-miss string
  // ('orca:wake…' for 'orca-wake…'), silently disconnecting every in-place wake.
  it('receives a wake dispatched under the shared event constant', () => {
    const wake = vi.fn(() => null)
    install({ wakeHibernatedAgentIfArmed: wake })
    dispatchWake({ worktreeId: 'wt-1' })
    expect(wake).toHaveBeenCalledOnce()
  })

  it('collects the consumed claim key into the shared collector', () => {
    install({ wakeHibernatedAgentIfArmed: () => 'claim-1' })
    const wokenClaimKeys = new Set<string>()
    dispatchWake({ worktreeId: 'wt-1', wokenClaimKeys })
    expect([...wokenClaimKeys]).toEqual(['claim-1'])
  })

  it('ignores wakes for another worktree', () => {
    const wake = vi.fn(() => null)
    install({ wakeHibernatedAgentIfArmed: wake })
    dispatchWake({ worktreeId: 'wt-other' })
    expect(wake).not.toHaveBeenCalled()
  })

  it('ignores a tab-scoped wake naming a different tab', () => {
    const wake = vi.fn(() => null)
    install({ wakeHibernatedAgentIfArmed: wake })
    dispatchWake({ worktreeId: 'wt-1', tabId: 'tab-other' })
    expect(wake).not.toHaveBeenCalled()
  })

  it('consumes a tab-scoped wake naming its own tab', () => {
    const wake = vi.fn(() => null)
    install({ wakeHibernatedAgentIfArmed: wake })
    dispatchWake({ worktreeId: 'wt-1', tabId: 'tab-a' })
    expect(wake).toHaveBeenCalledOnce()
  })

  it('stops listening after cleanup', () => {
    const wake = vi.fn(() => null)
    install({ wakeHibernatedAgentIfArmed: wake })
    cleanups.pop()?.()
    dispatchWake({ worktreeId: 'wt-1' })
    expect(wake).not.toHaveBeenCalled()
  })
})
