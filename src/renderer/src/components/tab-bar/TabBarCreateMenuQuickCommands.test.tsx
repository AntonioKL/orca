// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { TabBarCreateMenuQuickCommands } from './TabBarCreateMenuQuickCommands'
import type { HostedTerminalQuickCommand } from '@/hooks/use-terminal-quick-command-hosts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function hosted(id: string, label: string, command: string): HostedTerminalQuickCommand {
  return {
    command: { id, label, command, appendEnter: true },
    hostId: 'local',
    hostLabel: 'This computer',
    key: `local\0${id}`
  }
}

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

describe('TabBarCreateMenuQuickCommands', () => {
  it('labels the section and names what each row will run', () => {
    const onRun = vi.fn()
    const entries = [hosted('a', 'Run tests', 'pnpm test')]
    act(() => {
      root.render(
        <DropdownMenu open modal={false}>
          <DropdownMenuContent>
            <TabBarCreateMenuQuickCommands entries={entries} onRun={onRun} />
          </DropdownMenuContent>
        </DropdownMenu>
      )
    })

    const item = document.querySelector('[role="menuitem"]')
    expect(document.body.textContent).toContain('Quick Commands')
    expect(item?.textContent).toContain('Run tests')
    expect(item?.getAttribute('title')).toBe('pnpm test')

    act(() => {
      item!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(onRun).toHaveBeenCalledWith(entries[0])
  })
})
