/**
 * The re-pull chain as the target sync actually wires it (STA-3593): a snapshot whose tab rows
 * cannot be placed leaves the target un-hydrated and re-pulls, because the missing input is the
 * host catalog, and a later attempt can get it. Covers the seam between
 * `applyDirectSshRemoteWorkspaceSnapshot`'s placement verdict and `createUnplacedSnapshotRepull`
 * against a real store, so the chain is judged on hydration state rather than on mock traffic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'
import type { DirectSshPreparationInput } from './direct-ssh-reconnect-coordinator'
import { createRemoteWorkspaceTargetSync } from './remote-workspace-target-sync'
import { UNPLACED_SNAPSHOT_REPULL_DELAYS_MS } from './remote-workspace-unplaced-snapshot-repull'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const TARGET_ID = 'target-a'
const REPO_ROOT = '/srv/proj'
const HOST_PATH = `${REPO_ROOT}/alpha`
const WORKTREE_ID = `repo-a::${HOST_PATH}`
const TOTAL_CHAIN_MS = UNPLACED_SNAPSHOT_REPULL_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)

const owner: DirectSshAuthority = {
  targetId: TARGET_ID,
  providerEpoch: 'epoch-a' as SshProviderEpoch,
  connectionGeneration: 1
}

/** Two host terminals living on a host path this client has no catalog row for. */
function snapshot(revision = 4): RemoteWorkspaceSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    session: {
      activeWorktreePath: HOST_PATH,
      activeTabId: 'T1',
      tabsByWorktreePath: {
        [HOST_PATH]: [0, 1].map((index) => ({
          id: `T${index + 1}`,
          worktreePath: HOST_PATH,
          ptyId: `pty-T${index + 1}`,
          title: `Terminal ${index + 1}`,
          customTitle: null,
          color: null,
          sortOrder: index,
          createdAt: index + 1
        }))
      },
      terminalLayoutsByTabId: {}
    }
  }
}

type TestStore = ReturnType<typeof createTestStore>

function createHarness() {
  const store = createTestStore()
  store.setState({
    workspaceSessionReady: true,
    repos: [
      {
        id: 'repo-a',
        path: REPO_ROOT,
        displayName: 'Proj',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: TARGET_ID,
        executionHostId: `ssh:${TARGET_ID}`
      } as never
    ],
    reconnectPersistedTerminals: (async () => {}) as never
  })

  let authority: DirectSshAuthority | null = owner
  const get = vi.fn(async () => snapshot())
  const sync = createRemoteWorkspaceTargetSync({
    store,
    remoteWorkspace: { get, setForConnectedTargets: vi.fn(async () => []) },
    getCurrentAuthority: () => authority,
    isPreparationTokenCurrent: () => authority !== null,
    capturePreparationInput: async (
      current,
      reason,
      snapshotRevision
    ): Promise<DirectSshPreparationInput> => ({
      ...current,
      catalogRevision: 1,
      repoRefs: [{ repoId: 'repo-a', executionHostId: `ssh:${TARGET_ID}` }],
      authorityRequirement: 'required',
      reason,
      snapshotRevision
    }),
    // Degraded preparation still issues a token on purpose, so terminals reconnect.
    prepareOnly: async (input) => ({
      status: 'degraded' as const,
      token: {
        authority: owner,
        catalogRevision: 1,
        repoFingerprint: 'fp',
        authorityRequirement: 'required' as const,
        snapshotRevision: input.snapshotRevision ?? null,
        outcome: 'degraded' as const
      },
      repoOutcomes: {
        complete: 0,
        'non-authoritative': 1,
        'timed-out': 0,
        'cancel-budget-exhausted': 0,
        canceled: 0,
        stale: 0,
        rejected: 0
      },
      lineageOutcome: 'degraded' as const
    }),
    finalizeHydratedTerminals: () => 0
  })

  return {
    store,
    sync,
    get,
    dropAuthority: () => {
      authority = null
    }
  }
}

/** What the degraded lineage read failed to deliver. */
function landHostCatalog(store: TestStore): void {
  store.setState({
    worktreesByRepo: {
      'repo-a': [
        makeWorktree({
          id: WORKTREE_ID,
          repoId: 'repo-a',
          path: HOST_PATH,
          hostId: `ssh:${TARGET_ID}`
        } as never)
      ]
    }
  })
}

function isHydrated(store: TestStore): boolean {
  return store.getState().remoteWorkspaceHydratedTargetIds.has(TARGET_ID)
}

function syncPhase(store: TestStore): string | undefined {
  return store.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]?.phase
}

function adoptedTabIds(store: TestStore): string[] {
  return Object.values(store.getState().tabsByWorktree)
    .flat()
    .map((tab) => tab.id)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('target sync re-pulling a snapshot it could not place', () => {
  it('leaves the target un-hydrated and re-pulls while the catalog is missing', async () => {
    const harness = createHarness()

    const placement = await harness.sync.applyUnsolicitedSnapshot(TARGET_ID, snapshot())

    expect(placement).toBe('unplaced')
    expect(adoptedTabIds(harness.store)).toEqual([])
    expect(isHydrated(harness.store), 'an unplaceable snapshot is not the host picture').toBe(false)
    expect(syncPhase(harness.store)).toBe('pulling')

    await vi.advanceTimersByTimeAsync(UNPLACED_SNAPSHOT_REPULL_DELAYS_MS[0])
    expect(harness.get, 'the first retry did not re-read the host').toHaveBeenCalledTimes(1)
    expect(isHydrated(harness.store)).toBe(false)
  })

  it('adopts the host tabs and hydrates once a retry finds the catalog', async () => {
    const harness = createHarness()
    await harness.sync.applyUnsolicitedSnapshot(TARGET_ID, snapshot())

    landHostCatalog(harness.store)
    await vi.advanceTimersByTimeAsync(UNPLACED_SNAPSHOT_REPULL_DELAYS_MS[0])

    expect(adoptedTabIds(harness.store), 'the retry recovered the host terminals').toEqual([
      'T1',
      'T2'
    ])
    expect(isHydrated(harness.store)).toBe(true)
    expect(syncPhase(harness.store)).toBe('synced')

    // The chain retired on success rather than re-pulling over a correctly hydrated target.
    await vi.advanceTimersByTimeAsync(TOTAL_CHAIN_MS * 10)
    expect(harness.get).toHaveBeenCalledTimes(1)
    expect(adoptedTabIds(harness.store)).toEqual(['T1', 'T2'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles the target after a bounded number of retries instead of pulling forever', async () => {
    const harness = createHarness()
    await harness.sync.applyUnsolicitedSnapshot(TARGET_ID, snapshot())

    await vi.advanceTimersByTimeAsync(TOTAL_CHAIN_MS)
    expect(harness.get).toHaveBeenCalledTimes(UNPLACED_SNAPSHOT_REPULL_DELAYS_MS.length)

    // Settling back to hydrated is deliberate: a host-side deletion makes a path unplaceable for
    // good, and a permanently un-hydrated target would never upload its workspace again.
    expect(isHydrated(harness.store)).toBe(true)
    expect(syncPhase(harness.store)).toBe('synced')

    await vi.advanceTimersByTimeAsync(TOTAL_CHAIN_MS * 10)
    expect(harness.get, 'the chain kept re-pulling past exhaustion').toHaveBeenCalledTimes(
      UNPLACED_SNAPSHOT_REPULL_DELAYS_MS.length
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-pulls nothing after stop()', async () => {
    const harness = createHarness()
    await harness.sync.applyUnsolicitedSnapshot(TARGET_ID, snapshot())

    harness.sync.stop()

    await vi.advanceTimersByTimeAsync(TOTAL_CHAIN_MS * 10)
    expect(harness.get).not.toHaveBeenCalled()
    expect(isHydrated(harness.store)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('abandons the chain when the target loses its authority', async () => {
    const harness = createHarness()
    await harness.sync.applyUnsolicitedSnapshot(TARGET_ID, snapshot())

    harness.dropAuthority()

    await vi.advanceTimersByTimeAsync(TOTAL_CHAIN_MS * 10)
    expect(harness.get).not.toHaveBeenCalled()
    expect(isHydrated(harness.store)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('target sync applying a snapshot it can place', () => {
  it('hydrates and marks synced exactly as before the unplaced gate existed', async () => {
    const harness = createHarness()
    landHostCatalog(harness.store)

    const placement = await harness.sync.applyUnsolicitedSnapshot(TARGET_ID, snapshot())

    expect(placement).toBe('placed')
    expect(harness.store.getState().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'T1',
      'T2'
    ])
    expect(isHydrated(harness.store)).toBe(true)
    expect(syncPhase(harness.store)).toBe('synced')
    expect(harness.store.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]?.revision).toBe(
      4
    )

    // No re-pull chain is armed on the happy path at all.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(TOTAL_CHAIN_MS * 10)
    expect(harness.get).not.toHaveBeenCalled()
  })
})
