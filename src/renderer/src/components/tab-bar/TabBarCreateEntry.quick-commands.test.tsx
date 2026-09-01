// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { HostedTerminalQuickCommand } from '@/hooks/use-terminal-quick-command-hosts'

const fileListMock = vi.hoisted(() => ({
  current: { files: [] as string[], loading: false, loadError: null as string | null }
}))
vi.mock('../quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => fileListMock.current
}))

const tabSearchMock = vi.hoisted(() => ({
  calls: [] as { enabled: boolean; query: string }[],
  results: [] as unknown[]
}))
vi.mock('./use-open-tab-search', () => ({
  useOpenTabSearch: ({ enabled, query }: { enabled: boolean; query: string }) => {
    tabSearchMock.calls.push({ enabled, query })
    return { query, results: tabSearchMock.results }
  }
}))

import TabBarCreateEntry from './TabBarCreateEntry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function renderEntry(props: Record<string, unknown> = {}): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <TabBarCreateEntry
          worktreeId="wt"
          groupId="g"
          menuOpen
          onOpenEntry={vi.fn().mockResolvedValue(undefined)}
          {...props}
        />
      </TooltipProvider>
    )
  })
}

function setQuery(value: string): void {
  const input = container.querySelector('input')!
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set
  act(() => {
    nativeSetter?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

function submit(): void {
  act(() => {
    container
      .querySelector('form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  fileListMock.current = { files: [], loading: false, loadError: null }
  tabSearchMock.calls = []
  tabSearchMock.results = []
  useAppStore.setState(
    { ...useAppStore.getInitialState(), browserDefaultSearchEngine: null } as AppState,
    true
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

function hosted(id: string, label: string): HostedTerminalQuickCommand {
  return {
    command: { id, label, command: `echo ${id}`, appendEnter: true },
    hostId: 'local',
    hostLabel: 'This computer',
    key: `local\0${id}`
  }
}

const quickCommandOptions = [hosted('a', 'Run tests'), hosted('b', 'Deploy staging')]

describe('TabBarCreateEntry quick commands', () => {
  it('offers a matching quick command and runs the clicked one', () => {
    const onRunQuickCommand = vi.fn()
    renderEntry({ quickCommandOptions, onRunQuickCommand })
    setQuery('deploy')

    const rows = [...container.querySelectorAll('[role="option"]')]
    const quickCommandRow = rows.find((row) => row.textContent?.includes('Deploy staging'))
    expect(quickCommandRow?.textContent).toContain('Run quick command')
    act(() => {
      quickCommandRow!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })

    expect(onRunQuickCommand).toHaveBeenCalledWith(quickCommandOptions[1])
  })

  it('ranks an exact quick-command match above the search fallback and runs it on Enter', () => {
    const onRunQuickCommand = vi.fn()
    renderEntry({ quickCommandOptions, onRunQuickCommand })
    setQuery('run tests')

    expect(container.querySelector('[role="option"]')?.textContent).toContain('Run tests')
    submit()

    expect(onRunQuickCommand).toHaveBeenCalledWith(quickCommandOptions[0])
  })

  it('leaves quick commands out of an unmatched query', () => {
    renderEntry({ quickCommandOptions })
    setQuery('zzz-nothing')

    expect(container.textContent).not.toContain('Run quick command')
  })
})
