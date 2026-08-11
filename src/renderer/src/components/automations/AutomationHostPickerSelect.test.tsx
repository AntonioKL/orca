// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AutomationHostFilter } from '../../../../shared/automation-host-filter'
import { AutomationHostPickerSelect } from './AutomationHostPickerSelect'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'

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

function sshEntry(targetId: string, label: string): AutomationHostCatalogEntry {
  return {
    stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId } },
    owner: null,
    stableKey: `host:desktop:ssh:${targetId}`,
    label,
    authorityLabel: 'This computer',
    kind: 'ssh',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped'
  }
}

function runtimeSelf(environmentId: string, label: string): AutomationHostCatalogEntry {
  return {
    stableRef: { authority: { kind: 'runtime', environmentId }, selector: { kind: 'self' } },
    owner: null,
    stableKey: `host:runtime:${environmentId}:self`,
    label,
    authorityLabel: label,
    kind: 'self',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped'
  }
}

function render(
  entries: readonly AutomationHostCatalogEntry[],
  onSelect: (filter: AutomationHostFilter) => void = () => undefined
): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <AutomationHostPickerSelect
          entries={entries}
          selectedStableKey={null}
          triggerLabel="All hosts"
          pickerLabel="Filter by host"
          onSelect={onSelect}
        />
      </TooltipProvider>
    )
  })
}

/** Radix opens on the documented keyboard path, so no pointer emulation is needed. */
function openWithKeyboard(): void {
  const trigger = container.querySelector('[data-picker-variant="select"]')
  act(() => {
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

function groups(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="select-group"]')]
}

function accessibleGroupName(group: HTMLElement): string | null {
  const labelledBy = group.getAttribute('aria-labelledby')
  if (!labelledBy) {
    return null
  }
  return document.getElementById(labelledBy)?.textContent ?? null
}

describe('AutomationHostPickerSelect authority grouping', () => {
  it('groups entries under a real accessible group name, not a visual heading', () => {
    render([sshEntry('t0', 'web-00'), runtimeSelf('env-1', 'Build box')])
    openWithKeyboard()

    const rendered = groups()
    expect(rendered.length).toBe(2)
    for (const group of rendered) {
      expect(group.getAttribute('role')).toBe('group')
    }
    expect(rendered.map(accessibleGroupName)).toEqual(['This computer', 'Build box'])
  })

  it('scopes each host row to its own authority group', () => {
    render([sshEntry('t0', 'web-00'), runtimeSelf('env-1', 'Build box')])
    openWithKeyboard()

    // The label inside each row repeats the key, so match the row element itself.
    const keysByGroup = groups().map((group) =>
      [...group.querySelectorAll('[data-slot="select-item"][data-host-stable-key]')].map((node) =>
        node.getAttribute('data-host-stable-key')
      )
    )
    expect(keysByGroup).toEqual([['host:desktop:ssh:t0'], ['host:runtime:env-1:self']])
  })

  it('keeps All hosts outside every authority group', () => {
    render([sshEntry('t0', 'web-00')])
    openWithKeyboard()

    const allHosts = [...document.querySelectorAll('[data-slot="select-item"]')].find((node) =>
      node.textContent?.includes('All hosts')
    )
    expect(allHosts).toBeDefined()
    expect(allHosts?.closest('[data-slot="select-group"]')).toBeNull()
  })

  it('names the group once instead of repeating the authority on every row', () => {
    render([sshEntry('t0', 'web-00'), sshEntry('t1', 'web-01')])
    openWithKeyboard()

    const rows = [...document.querySelectorAll('[data-host-stable-key]')]
    const authorityMentions = rows.filter((row) =>
      row.textContent?.includes('This computer')
    ).length
    expect(authorityMentions).toBe(0)
    expect(groups().map(accessibleGroupName)).toEqual(['This computer'])
  })

  it('reports the chosen host as a stable filter', () => {
    const onSelect = vi.fn()
    render([sshEntry('t0', 'web-00'), sshEntry('t1', 'web-01')], onSelect)
    openWithKeyboard()

    const row = document.querySelector('[data-host-stable-key="host:desktop:ssh:t1"]')
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onSelect).toHaveBeenCalledWith({
      kind: 'host',
      host: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 't1' } }
    })
  })
})
