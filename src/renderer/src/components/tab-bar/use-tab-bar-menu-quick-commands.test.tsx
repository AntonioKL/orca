// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useTabBarMenuQuickCommands } from './use-tab-bar-menu-quick-commands'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  renders = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

let renders = 0

function Probe({ menuOpen }: { menuOpen: boolean }): React.JSX.Element {
  renders += 1
  const { menuQuickCommands, quickCommandOptions } = useTabBarMenuQuickCommands({
    menuOpen,
    onQueueTerminalFocus: vi.fn(),
    resolvedGroupId: 'group',
    worktreeId: 'repo::wt'
  })
  return <span>{`${quickCommandOptions.length}:${menuQuickCommands.length}`}</span>
}

describe('useTabBarMenuQuickCommands', () => {
  // Why this is a perf test: this runs in every TabBar, one per tab group, for
  // the whole life of the app. Zustand invokes every registered selector on
  // every store write, so a closed menu that reads even one field would charge
  // all of them for a surface nobody is looking at.
  it('registers no selector that reads store state while the menu is closed', () => {
    act(() => {
      root.render(<Probe menuOpen={false} />)
    })
    const real = useAppStore.getState()
    const trap = new Proxy(real, {
      get(_target, property) {
        throw new Error(`closed menu read state.${String(property)}`)
      }
    })

    try {
      // Replacing state notifies every subscriber and act() flushes the snapshot
      // reads, so a selector that touches the new state throws here.
      expect(() =>
        act(() => {
          useAppStore.setState(trap as AppState, true)
        })
      ).not.toThrow()
    } finally {
      act(() => {
        useAppStore.setState(real, true)
      })
    }
  })

  it('does not re-render its host when quick-command state changes underneath', () => {
    act(() => {
      root.render(<Probe menuOpen={false} />)
    })
    const before = renders

    for (let write = 0; write < 5; write += 1) {
      act(() => {
        useAppStore.setState({ recentQuickCommandIdByGroup: { group: `cmd-${write}` } })
      })
    }

    expect(renders).toBe(before)
  })

  it('offers nothing to render while the menu is closed', () => {
    act(() => {
      root.render(<Probe menuOpen={false} />)
    })
    expect(container.textContent).toBe('0:0')
  })
})
