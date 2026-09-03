import { describe, expect, it } from 'vitest'

import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { findTerminalTabIdForLeaf } from './workspace-session-terminal-membership-authority'
import { getTerminalLeafMembershipIndex } from './terminal-leaf-membership-index'

function layout(...leafIds: string[]): TerminalLayoutSnapshot {
  let root = { type: 'leaf' as const, leafId: leafIds[0] }
  for (const leafId of leafIds.slice(1)) {
    root = {
      type: 'split',
      direction: 'row',
      first: root,
      second: { type: 'leaf' as const, leafId }
    } as never
  }
  return { root, activeLeafId: leafIds[0], ptyIdsByLeafId: {} } as TerminalLayoutSnapshot
}

function session(layouts: Record<string, TerminalLayoutSnapshot>): WorkspaceSessionState {
  return { terminalLayoutsByTabId: layouts } as WorkspaceSessionState
}

describe('getTerminalLeafMembershipIndex', () => {
  it('maps every leaf in a split tree to its tab', () => {
    const index = getTerminalLeafMembershipIndex({
      'tab-a': layout('leaf-1', 'leaf-2', 'leaf-3'),
      'tab-b': layout('leaf-4')
    })
    expect([...index]).toEqual([
      ['leaf-1', 'tab-a'],
      ['leaf-2', 'tab-a'],
      ['leaf-3', 'tab-a'],
      ['leaf-4', 'tab-b']
    ])
  })

  it('keeps the first tab in record order when two layouts claim one leaf', () => {
    const layouts = { 'tab-a': layout('shared'), 'tab-b': layout('shared') }
    expect(getTerminalLeafMembershipIndex(layouts).get('shared')).toBe('tab-a')
    expect(findTerminalTabIdForLeaf(session(layouts), 'shared')).toBe('tab-a')
  })

  it('returns the same map instance for an unchanged record', () => {
    const layouts = { 'tab-a': layout('leaf-1') }
    expect(getTerminalLeafMembershipIndex(layouts)).toBe(getTerminalLeafMembershipIndex(layouts))
  })

  it('rebuilds when a layout object inside the same record is replaced', () => {
    const layouts: Record<string, TerminalLayoutSnapshot> = { 'tab-a': layout('leaf-1') }
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-1')).toBe('tab-a')
    layouts['tab-a'] = layout('leaf-9')
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-1')).toBeUndefined()
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-9')).toBe('tab-a')
  })

  it('rebuilds when a tab is added to or removed from the same record', () => {
    const layouts: Record<string, TerminalLayoutSnapshot> = { 'tab-a': layout('leaf-1') }
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-1')).toBe('tab-a')
    layouts['tab-b'] = layout('leaf-2')
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-2')).toBe('tab-b')
    delete layouts['tab-a']
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-1')).toBeUndefined()
  })

  it('answers misses and empty sessions the same way the linear scan did', () => {
    expect(findTerminalTabIdForLeaf(undefined, 'leaf-1')).toBeUndefined()
    expect(findTerminalTabIdForLeaf(session({}), 'leaf-1')).toBeUndefined()
    expect(findTerminalTabIdForLeaf(session({ 'tab-a': layout('leaf-1') }), 'nope')).toBeUndefined()
  })

  // `persistPtyBinding` grafts a leaf by assigning `layout.root` on the SAME layout object in the
  // SAME record — a layout-identity check would keep serving an index blind to the new leaf.
  it('rebuilds when a layout root is replaced in place on the same layout object', () => {
    const tracked = layout('leaf-1')
    const layouts: Record<string, TerminalLayoutSnapshot> = { 'tab-a': tracked }
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-1')).toBe('tab-a')
    tracked.root = {
      type: 'split',
      direction: 'vertical',
      first: tracked.root,
      second: { type: 'leaf', leafId: 'leaf-2' }
    } as never
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-2')).toBe('tab-a')
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-1')).toBe('tab-a')
  })

  it('rebuilds when an empty layout gets its first root in place', () => {
    const tracked = { root: null, activeLeafId: null, ptyIdsByLeafId: {} } as TerminalLayoutSnapshot
    const layouts: Record<string, TerminalLayoutSnapshot> = { 'tab-a': tracked }
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-1')).toBeUndefined()
    tracked.root = { type: 'leaf', leafId: 'leaf-1' }
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-1')).toBe('tab-a')
  })

  it('does not walk a layout tree again once the record is indexed', () => {
    let nodeVisits = 0
    // Stable node object: revalidation only compares its reference, a rebuild reads `type`.
    const root = {
      get type() {
        nodeVisits += 1
        return 'leaf' as const
      },
      leafId: 'leaf-1'
    } as unknown as TerminalPaneLayoutNode
    const layouts = {
      'tab-a': { root, activeLeafId: 'leaf-1', ptyIdsByLeafId: {} } as TerminalLayoutSnapshot
    }
    for (let i = 0; i < 50; i += 1) {
      findTerminalTabIdForLeaf(session(layouts), `leaf-${i}`)
    }
    expect(nodeVisits).toBe(1)
  })
})
