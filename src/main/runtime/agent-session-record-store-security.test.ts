import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { createCodexStructuredLaunchResolver } from '../codex/codex-structured-launch-resolution'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

const NOW = 1_800_000_000_000
let directory: string

function resumableRecord(sessionId: string): AgentSessionRecord {
  const threadId = `thread-${sessionId}`
  return {
    schemaVersion: 2,
    sessionId,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: `workspace-${sessionId}`,
      workspaceKind: 'folder'
    },
    provider: 'codex',
    providerHandleChain: [
      {
        linkId: `link-${sessionId}`,
        handle: { provider: 'codex', threadId },
        origin: 'created',
        mintedAtFence: 1,
        observedAt: NOW
      }
    ],
    accountHome: { variable: 'CODEX_HOME', path: `/accounts/${sessionId}` },
    launchEnv: {
      PATH: '/custom/bin:/usr/bin',
      MY_COMPANY_CREDS: 'fixture-credentials',
      GITHUB_TOKEN: 'fixture-token'
    },
    lease: {
      sessionId,
      runtimeKind: 'native',
      runtimeFence: 1,
      handoffStage: null,
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      leaseDeadlineAt: NOW,
      lastRenewedAt: NOW,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: 'key-1',
      claimStatus: 'released',
      unreconciled: false,
      deathEvidence: null
    },
    createdAt: NOW,
    updatedAt: NOW
  }
}

function storePayload(): string {
  const records = Object.fromEntries(
    ['session-live-a', 'session-live-b'].map((sessionId) => [
      sessionId,
      { ...resumableRecord(sessionId), futureRecordField: { preserved: true } }
    ])
  )
  return JSON.stringify({
    schemaVersion: 2,
    hostId: 'local',
    records,
    operations: {},
    retiredClaimKeys: [],
    unusableRecords: {},
    futureStoreField: { preserved: true }
  })
}

function reserveRequest(): AgentSessionReserveRequest {
  return {
    sessionId: 'session-created',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-created',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/accounts/created' },
    launchEnv: { PATH: '/usr/bin' },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-created',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-00000000000000000000000000000001`,
      fingerprint: 'fp-1'
    },
    now: NOW
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-security-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('agent session record store security', () => {
  it('scrubs both committed generations without losing resumable sessions', async () => {
    const filePath = agentSessionStorePath(directory)
    await Promise.all([
      writeFile(filePath, storePayload()),
      writeFile(`${filePath}.bak`, storePayload())
    ])
    if (process.platform !== 'win32') {
      await chmod(directory, 0o755)
      await Promise.all([chmod(filePath, 0o644), chmod(`${filePath}.bak`, 0o644)])
    }
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })

    expect(store.readOnly).toBe(false)
    expect(
      store
        .listRecords()
        .map((record) => record.sessionId)
        .sort()
    ).toEqual(['session-live-a', 'session-live-b'])
    for (const committedPath of [filePath, `${filePath}.bak`]) {
      const raw = await readFile(committedPath, 'utf-8')
      expect(raw).not.toContain('MY_COMPANY_CREDS')
      expect(raw).not.toContain('GITHUB_TOKEN')
      const parsed = JSON.parse(raw) as {
        records: Record<string, AgentSessionRecord & { futureRecordField?: unknown }>
        futureStoreField?: unknown
      }
      const { records } = parsed
      expect(Object.keys(records).sort()).toEqual(['session-live-a', 'session-live-b'])
      expect(records['session-live-a']).not.toHaveProperty('launchEnv')
      expect(parsed.futureStoreField).toEqual({ preserved: true })
      expect(records['session-live-a']?.futureRecordField).toEqual({ preserved: true })
      if (process.platform !== 'win32') {
        expect((await stat(committedPath)).mode & 0o777).toBe(0o600)
      }
    }
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
    }

    const resolveCommand = vi.fn(() => '/custom/bin/codex')
    const resolveLaunch = createCodexStructuredLaunchResolver({
      store,
      resolveWorkspacePath: async (workspaceId) => `/workspaces/${workspaceId}`,
      resolveCommand,
      resolveEnvironment: async () => ({
        PATH: '/fresh/bin:/usr/bin',
        MY_COMPANY_CREDS: 'fresh-fixture-credentials'
      })
    })
    for (const sessionId of ['session-live-a', 'session-live-b']) {
      const launch = await resolveLaunch({
        identity: {
          sessionId,
          workspaceId: `workspace-${sessionId}`,
          hostId: 'local',
          agent: 'codex',
          providerHandle: { kind: 'codex', threadId: `thread-${sessionId}` }
        }
      })
      expect(launch).toMatchObject({
        command: '/custom/bin/codex',
        codexHome: `/accounts/${sessionId}`,
        resumeThreadId: `thread-${sessionId}`,
        env: {
          PATH: '/fresh/bin:/usr/bin',
          MY_COMPANY_CREDS: 'fresh-fixture-credentials'
        }
      })
    }
    expect(resolveCommand).toHaveBeenCalledTimes(2)
    expect(resolveCommand).toHaveBeenCalledWith({ pathEnv: '/fresh/bin:/usr/bin' })
  })

  it.skipIf(process.platform === 'win32')(
    'creates the directory and store owner-only',
    async () => {
      const nestedDirectory = join(directory, 'agent-sessions')
      await chmod(directory, 0o755)
      const store = await AgentSessionRecordStore.open({
        directory: nestedDirectory,
        hostId: 'local'
      })
      await store.reserveOwner(reserveRequest())

      expect((await stat(nestedDirectory)).mode & 0o777).toBe(0o700)
      expect((await stat(agentSessionStorePath(nestedDirectory))).mode & 0o777).toBe(0o600)
    }
  )
})
