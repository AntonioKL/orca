import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import type { PersistedState } from '../shared/persisted-state-types'
import { makeBalancedLegacyPaneLayout } from './persistence-session-fixtures'
import { Store } from './persistence/loading-store/store'

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

function writeProfile(dir: string, state: Record<string, unknown>): string {
  const dataFile = join(dir, 'orca-data.json')
  writeFileSync(dataFile, JSON.stringify(state), 'utf-8')
  return dataFile
}

function legacySplitLayoutProfile(tabId: string, ptyId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    workspaceSession: {
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: tabId,
      tabsByWorktree: {
        wt1: [
          {
            id: tabId,
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId
          }
        ]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: makeBalancedLegacyPaneLayout(0, 2),
          activeLeafId: 'pane:1',
          expandedLeafId: null
        }
      }
    }
  }
}

function readProfile(dataFile: string): PersistedState {
  return JSON.parse(readFileSync(dataFile, 'utf-8')) as PersistedState
}

describe('Store hook-server listener ownership', () => {
  let dirs: string[] = []

  beforeEach(() => {
    dirs = []
    installFakeAppEnvironment({ getPath: () => tmpdir() })
  })

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-listener-ownership-'))
    dirs.push(dir)
    return dir
  }

  it('does not write a later store’s hydrated aliases into an earlier store’s profile', () => {
    const earlierFile = writeProfile(makeDir(), { schemaVersion: 1 })
    const earlier = new Store({ dataFile: earlierFile })

    // Why: the later store replays its own legacy layout; the earlier store must not observe it.
    const laterFile = writeProfile(makeDir(), legacySplitLayoutProfile('tab-later', 'pty-later'))
    new Store({ dataFile: laterFile })

    earlier.flush()
    const earlierAliases = readProfile(earlierFile).legacyPaneKeyAliasEntries ?? []
    expect(earlierAliases).toEqual([])
  })

  it('still persists a store’s own hydrated aliases after it takes ownership', () => {
    const dataFile = writeProfile(makeDir(), legacySplitLayoutProfile('tab-own', 'pty-own'))
    const store = new Store({ dataFile })

    store.flush()
    const aliases = readProfile(dataFile).legacyPaneKeyAliasEntries ?? []
    expect(aliases.some((entry) => entry.legacyPaneKey === 'tab-own:1')).toBe(true)
  })
})
