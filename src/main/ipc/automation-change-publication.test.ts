/**
 * A definition change must name the host it affected, and a change that moves a
 * record between hosts must name both — a subscriber that never hears about the
 * source keeps rendering a row that has left it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Automation } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { getDefaultPersistedState } from '../../shared/constants'
import type { AutomationsChangedPayload } from '../../shared/runtime-client-events'

const testState = { dir: '' }
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const REPOS = [
  { id: 'repo-local', path: '/local', displayName: 'Local', badgeColor: '#000', addedAt: 1 },
  {
    id: 'repo-ssh',
    path: '/remote',
    displayName: 'Remote',
    badgeColor: '#000',
    addedAt: 2,
    connectionId: 'ssh-1'
  }
] as Repo[]

const TARGETS = [
  { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me', generation: 7 }
] as SshTarget[]

function automation(overrides: Partial<Automation>): Automation {
  return {
    id: 'local-1',
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

const AUTOMATIONS = [
  automation({}),
  automation({
    id: 'ssh-1-a',
    projectId: 'repo-ssh',
    executionTargetType: 'ssh',
    executionTargetId: 'ssh-1',
    executionTargetGeneration: 7
  }),
  automation({
    id: 'orphan-1',
    projectId: 'repo-ssh',
    executionTargetType: 'ssh',
    executionTargetId: 'ssh-gone',
    executionTargetGeneration: 3
  })
]

async function registerHandlers() {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({
      ...getDefaultPersistedState(testState.dir),
      repos: REPOS,
      sshTargets: TARGETS,
      sshTargetGenerationCounter: 7,
      automations: AUTOMATIONS
    }),
    'utf-8'
  )
  vi.resetModules()
  handlers.clear()
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  const store = new Store()
  const published: AutomationsChangedPayload[] = []
  const service = {
    publishAutomationsChanged: (payload: AutomationsChangedPayload) => published.push(payload)
  }
  const { registerAutomationHandlers } = await import('./automations')
  registerAutomationHandlers(store, service as never)
  return { store, published }
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'automation-publish-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('scoped automationsChanged publication', () => {
  it('names the host a delete removed a row from', async () => {
    const { published } = await registerHandlers()
    await handlers.get('automations:delete')?.(null, {
      id: 'ssh-1-a',
      expectedOwner: { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } }
    })
    expect(published).toEqual([
      { reason: 'definition', selector: { kind: 'ssh', targetId: 'ssh-1' } }
    ])
  })

  it('names the orphan bucket when an unowned row is deleted', async () => {
    const { published } = await registerHandlers()
    await handlers.get('automations:delete')?.(null, {
      id: 'orphan-1',
      expectedOwner: { selector: { kind: 'orphan' } }
    })
    expect(published).toEqual([{ reason: 'definition', selector: { kind: 'orphan' } }])
  })

  it('publishes source and destination when an update moves a record between hosts', async () => {
    const { published, store } = await registerHandlers()
    await handlers.get('automations:update')?.(null, {
      id: 'local-1',
      updates: { projectId: 'repo-ssh' },
      expectedOwner: { selector: { kind: 'self' } },
      destination: { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } }
    })
    expect(published).toEqual([
      { reason: 'definition', selector: { kind: 'self' } },
      { reason: 'definition', selector: { kind: 'ssh', targetId: 'ssh-1' } }
    ])
    expect(store.automationChangeSelector('local-1')).toEqual({
      kind: 'ssh',
      targetId: 'ssh-1'
    })
  })

  it('publishes one event when an update leaves the record on the same host', async () => {
    const { published } = await registerHandlers()
    await handlers.get('automations:update')?.(null, {
      id: 'local-1',
      updates: { enabled: false },
      expectedOwner: { selector: { kind: 'self' } }
    })
    expect(published).toEqual([{ reason: 'definition', selector: { kind: 'self' } }])
  })
})
