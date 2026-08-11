// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AutomationHostFilter } from '../../../../shared/automation-host-filter'
import { AutomationHostPicker } from './AutomationHostPicker'
import { orderAutomationHostCatalogEntries } from './automation-host-catalog-order'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationHostFilterResolution } from './automation-host-filter-resolution'

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

function sshEntry(
  targetId: string,
  label: string,
  overrides: Partial<AutomationHostCatalogEntry> = {}
): AutomationHostCatalogEntry {
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
    querySupport: 'scoped',
    ...overrides
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

function manyEntries(count: number): AutomationHostCatalogEntry[] {
  return Array.from({ length: count }, (_, index) =>
    sshEntry(`t${index}`, `web-${String(index).padStart(2, '0')}`)
  )
}

const ALL_HOSTS: AutomationHostFilterResolution = {
  effective: { kind: 'all' },
  entry: null,
  status: 'all',
  announceFallback: false
}

function render(
  entries: readonly AutomationHostCatalogEntry[],
  onSelect: (filter: AutomationHostFilter) => void = () => undefined,
  resolution: AutomationHostFilterResolution = ALL_HOSTS
): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <AutomationHostPicker entries={entries} resolution={resolution} onSelect={onSelect} />
      </TooltipProvider>
    )
  })
}

function openCommandPicker(): void {
  const trigger = container.querySelector('[data-picker-variant="command"]')
  act(() => {
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function visibleHostKeys(): string[] {
  // The label inside each item repeats the key, so match the item element itself.
  return [...document.querySelectorAll('[data-slot="command-item"][data-host-stable-key]')].map(
    (node) => node.getAttribute('data-host-stable-key') ?? ''
  )
}

function typeSearch(value: string): void {
  const input = document.querySelector<HTMLInputElement>('[data-slot="command-input"]')
  if (!input) {
    throw new Error('command input not rendered')
  }
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('AutomationHostPicker primitive selection', () => {
  it('uses the unsearchable Select at eight entries', () => {
    render(manyEntries(8))
    expect(container.querySelector('[data-picker-variant="select"]')).not.toBeNull()
    expect(container.querySelector('[data-picker-variant="command"]')).toBeNull()
  })

  it('switches to the searchable Command picker at nine entries', () => {
    render(manyEntries(9))
    expect(container.querySelector('[data-picker-variant="select"]')).toBeNull()
    expect(container.querySelector('[data-picker-variant="command"]')).not.toBeNull()
  })

  it('labels both variants Filter by host', () => {
    render(manyEntries(8))
    expect(
      container.querySelector('[data-picker-variant="select"]')?.getAttribute('aria-label')
    ).toBe('Filter by host')
    render(manyEntries(9))
    expect(
      container.querySelector('[data-picker-variant="command"]')?.getAttribute('aria-label')
    ).toBe('Filter by host')
  })

  it('names the retained selection rather than All hosts while it loads', () => {
    render(manyEntries(9), () => undefined, {
      effective: { kind: 'host', host: sshEntry('t0', 'web-00').stableRef },
      entry: null,
      status: 'loading',
      announceFallback: false
    })
    expect(container.querySelector('[data-picker-variant="command"]')?.textContent).toContain(
      'Loading host…'
    )
  })

  it('names the retained selection in the Select variant too', () => {
    render(manyEntries(8), () => undefined, {
      effective: { kind: 'host', host: sshEntry('t0', 'web-00').stableRef },
      entry: null,
      status: 'loading',
      announceFallback: false
    })
    const trigger = container.querySelector('[data-picker-variant="select"]')
    expect(trigger?.textContent).toContain('Loading host…')
    expect(trigger?.textContent).not.toContain('All hosts')
  })
})

describe('AutomationHostPicker searchable variant', () => {
  it('offers All hosts and every entry, grouped by authority', () => {
    render([...manyEntries(9), runtimeSelf('env-1', 'Build box')])
    openCommandPicker()

    const headings = [...document.querySelectorAll('[cmdk-group-heading]')].map(
      (node) => node.textContent
    )
    expect(headings).toContain('This computer')
    expect(headings).toContain('Build box')
    expect(document.body.textContent).toContain('All hosts')
    expect(visibleHostKeys()).toHaveLength(10)
  })

  it('lists entries in the shared deterministic catalog order', () => {
    const entries = [...manyEntries(9), runtimeSelf('env-1', 'Build box')]
    const shuffled = [
      entries[4],
      entries[9],
      entries[0],
      ...entries.slice(1, 4),
      ...entries.slice(5, 9)
    ]
    render(shuffled)
    openCommandPicker()

    expect(visibleHostKeys()).toEqual(
      orderAutomationHostCatalogEntries(entries).map((entry) => entry.stableKey)
    )
  })

  it('filters the list by the search query', () => {
    render(manyEntries(12))
    openCommandPicker()
    expect(visibleHostKeys()).toHaveLength(12)

    typeSearch('web-03')
    expect(visibleHostKeys()).toEqual(['host:desktop:ssh:t3'])
  })

  it('reports no match without claiming the hosts are gone', () => {
    render(manyEntries(12))
    openCommandPicker()
    typeSearch('nothing-matches-this')

    expect(visibleHostKeys()).toEqual([])
    expect(document.querySelector('[data-slot="command-empty"]')?.textContent).toBe(
      'No hosts match'
    )
  })

  it('reports the chosen host as a stable filter', () => {
    const onSelect = vi.fn()
    render(manyEntries(9), onSelect)
    openCommandPicker()

    const item = document.querySelector('[data-host-stable-key="host:desktop:ssh:t3"]')
    act(() => {
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onSelect).toHaveBeenCalledWith({
      kind: 'host',
      host: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 't3' } }
    })
  })

  it('focuses search on open so the keyboard path starts in the field', () => {
    render(manyEntries(9))
    openCommandPicker()
    expect(document.activeElement).toBe(document.querySelector('[data-slot="command-input"]'))
  })

  it('closes on Escape without changing the selection', () => {
    const onSelect = vi.fn()
    render(manyEntries(9), onSelect)
    openCommandPicker()
    expect(document.querySelector('[data-slot="command-input"]')).not.toBeNull()

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(document.querySelector('[data-slot="command-input"]')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
  })
})
