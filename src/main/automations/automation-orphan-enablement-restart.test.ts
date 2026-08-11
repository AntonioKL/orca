/**
 * The user outranks the load migration. Every case here runs the real load path
 * twice — the migration is what re-runs on restart, so a test that only calls it
 * once cannot see the flip-back it used to cause.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Automation } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { getDefaultPersistedState } from '../../shared/constants'
import { isAutomationDisabledByOwnerMigration } from '../../shared/automation-enablement-decision'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

function automation(overrides: Partial<Automation>): Automation {
  return {
    id: 'a1',
    name: 'Nightly',
    prompt: 'go',
    precheck: null,
    agentId: 'claude',
    projectId: 'repo-local',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as Automation
}

const REPOS: Repo[] = [
  { id: 'repo-local', path: '/local', displayName: 'Local', badgeColor: '#000', addedAt: 1 },
  {
    id: 'repo-ssh',
    path: '/remote',
    displayName: 'Remote',
    badgeColor: '#000',
    addedAt: 2,
    connectionId: 'ssh-gone'
  }
] as Repo[]

const AUTOMATIONS: Automation[] = [
  automation({ id: 'local-1' }),
  automation({
    id: 'orphan-1',
    projectId: 'repo-ssh',
    executionTargetType: 'ssh',
    executionTargetId: 'ssh-gone',
    executionTargetGeneration: 3
  }),
  // schedulerOwner alone makes this ambiguous: a desktop record scheduled elsewhere.
  automation({ id: 'ambiguous-1', schedulerOwner: 'remote_host_service' })
]

type LoadedStore = Awaited<ReturnType<typeof loadStore>>

function seed(): void {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({
      ...getDefaultPersistedState(testState.dir),
      repos: REPOS,
      sshTargets: [] as SshTarget[],
      automations: AUTOMATIONS
    }),
    'utf-8'
  )
}

async function loadStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return new Store()
}

/** The restart: the running store's writes hit disk, then a fresh load re-migrates them. */
async function restart(store: LoadedStore): Promise<LoadedStore> {
  store.flush()
  return loadStore()
}

function find(store: LoadedStore, id: string): Automation {
  const found = store.listAutomations().find((entry) => entry.id === id)
  if (!found) {
    throw new Error(`Automation ${id} is missing`)
  }
  return found
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'automation-enablement-'))
  seed()
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('owner migration enablement decisions', () => {
  it('disables an unowned record on first load and records itself as the decider', async () => {
    const store = await loadStore()
    for (const id of ['orphan-1', 'ambiguous-1']) {
      const migrated = find(store, id)
      expect(migrated.enabled).toBe(false)
      expect(migrated.enabledDecidedBy).toBe('owner_migration')
      expect(isAutomationDisabledByOwnerMigration(migrated)).toBe(true)
    }
    expect(find(store, 'local-1').enabledDecidedBy).toBeUndefined()
  })

  it.each(['orphan-1', 'ambiguous-1'])(
    'keeps a user re-enable of %s across a restart',
    async (id) => {
      const first = await loadStore()
      expect(first.updateAutomation(id, { enabled: true }).enabled).toBe(true)

      const reloaded = await restart(first)
      const survived = find(reloaded, id)
      expect(survived.enabled).toBe(true)
      expect(survived.enabledDecidedBy).toBe('user')
      expect(isAutomationDisabledByOwnerMigration(survived)).toBe(false)
    }
  )

  it('still leaves a re-enabled orphan alone after several restarts', async () => {
    let store = await loadStore()
    store.updateAutomation('orphan-1', { enabled: true })
    store = await restart(store)
    store = await restart(store)
    expect(find(store, 'orphan-1').enabled).toBe(true)
  })

  it('attributes a user disable to the user, not to the migration', async () => {
    const store = await loadStore()
    store.updateAutomation('orphan-1', { enabled: true })
    const disabled = store.updateAutomation('orphan-1', { enabled: false })
    expect(disabled.enabledDecidedBy).toBe('user')
    expect(isAutomationDisabledByOwnerMigration(disabled)).toBe(false)

    // The record is off and stays off: the user's decision is not re-attributed on load.
    const reloaded = await restart(store)
    expect(find(reloaded, 'orphan-1').enabledDecidedBy).toBe('user')
  })

  it('does not attribute an unrelated edit to the user', async () => {
    const store = await loadStore()
    expect(store.updateAutomation('orphan-1', { prompt: 'changed' }).enabledDecidedBy).toBe(
      'owner_migration'
    )
  })
})
