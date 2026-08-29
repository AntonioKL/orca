/**
 * A refused removal republishes the row its preflight rescanned. That rescan is
 * newer than the list the user confirmed against — but it is not newer than a
 * refresh the user completed while the preflight was still running. These cases
 * pin that the republish never walks such a row backwards.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import {
  NOW,
  WORKTREE_ID,
  createCleanupTestStore,
  deferred,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

const DIRTY_BUFFER = [
  { id: 'file-1', worktreeId: WORKTREE_ID, path: '/tmp/old-workspace/a.ts', isDirty: true }
] as unknown as AppState['openFiles']

/**
 * The preflight's terminal probe is the await the refresh lands inside. Enrichment
 * reads store state before it, so a probe held open freezes the preflight's picture
 * of the workspace while the rest of the app moves on.
 */
function installRaceStore() {
  const gate = deferred<{ foregroundProcess: string | null; hasChildProcesses: boolean }>()
  let gated = false
  const gateProbe = <T>(gatedValue: unknown, laterValue: T) =>
    vi.fn(async () => {
      if (gated) {
        return laterValue
      }
      gated = true
      await gate.promise
      return gatedValue as T
    })

  const scan = vi.fn().mockResolvedValue({
    scannedAt: NOW,
    candidates: [makeCandidate()],
    errors: []
  })
  installWorkspaceCleanupApi(scan, vi.fn().mockResolvedValue(null), {
    inspectProcess: gateProbe(
      { foregroundProcess: 'codex', hasChildProcesses: true },
      { foregroundProcess: 'zsh', hasChildProcesses: false }
    ),
    hasChildProcesses: gateProbe(true, false),
    getForegroundProcess: gateProbe('codex', 'zsh')
  })
  ;(window.api.workspaceCleanup as { cancelScan?: unknown }).cancelScan = vi
    .fn()
    .mockResolvedValue(undefined)

  const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
  const store = createCleanupTestStore(removeWorktree)
  store.setState({
    tabsByWorktree: {
      [WORKTREE_ID]: [{ id: 'tab-1', title: 'zsh' }] as AppState['tabsByWorktree'][string]
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    openFiles: [],
    workspaceCleanupScan: { scannedAt: NOW, candidates: [makeCandidate()], errors: [] }
  } as Partial<AppState> as AppState)

  const listedRow = (): WorkspaceCleanupCandidate | undefined =>
    store.getState().workspaceCleanupScan?.candidates[0]
  return { store, scan, removeWorktree, listedRow, gate, isGated: () => gated }
}

describe('workspace cleanup republish against a newer scan', () => {
  it('keeps the refreshed row when a scan settles while the preflight runs', async () => {
    const { store, removeWorktree, listedRow, gate, isGated } = installRaceStore()

    const removal = store.getState().removeWorkspaceCleanupCandidates([WORKTREE_ID], {
      approvedCandidates: [makeCandidate({ blockers: [] })]
    })
    await vi.waitFor(() => expect(isGated()).toBe(true))

    // The user goes back to the list, opens a file, and refreshes. Everything
    // below runs through the real scan action, not a hand-written row.
    store.setState({ openFiles: DIRTY_BUFFER } as Partial<AppState> as AppState)
    await store.getState().scanWorkspaceCleanup()
    // Honesty check: without this the assertion below could pass on a row that
    // never carried the verdict.
    expect(listedRow()?.blockers).toContain('dirty-editor-buffer')

    gate.resolve({ foregroundProcess: 'codex', hasChildProcesses: true })
    const result = await removal

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(result.failures).toHaveLength(1)
    expect(listedRow()?.blockers).toContain('dirty-editor-buffer')
  })
})
