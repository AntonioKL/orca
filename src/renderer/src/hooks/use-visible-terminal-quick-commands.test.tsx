// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useVisibleTerminalQuickCommands } from './use-visible-terminal-quick-commands'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function Probe({ enabled }: { enabled: boolean }): React.JSX.Element {
  const { globalCommands, repoCommands } = useVisibleTerminalQuickCommands('repo::wt', enabled)
  return <span>{`${repoCommands.length}:${globalCommands.length}`}</span>
}

describe('useVisibleTerminalQuickCommands', () => {
  // Why this is a perf test: the "+" menu mounts this per tab group, and zustand
  // runs every registered selector on every store update. A disabled instance
  // that reads even one field would put that cost on every store write for the
  // whole life of the app, not just while a menu is open.
  it('registers no selector that reads store state while disabled', () => {
    act(() => {
      root.render(<Probe enabled={false} />)
    })
    const real = useAppStore.getState()
    const trap = new Proxy(real, {
      get(_target, property) {
        throw new Error(`disabled hook read state.${String(property)}`)
      }
    })

    try {
      // Replacing state notifies every subscriber and act() flushes the resulting
      // snapshot reads, so any selector that touches the new state throws here.
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

  it('reports no commands while disabled', () => {
    act(() => {
      root.render(<Probe enabled={false} />)
    })
    expect(container.textContent).toBe('0:0')
  })
})
