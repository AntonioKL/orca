import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { paneKeyPtyId, ptyPaneKey, registerPaneKeyRekeyListener } from '../ipc/pty/pane/key-state'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const INCARNATION_ID = 'provider-reattach-incarnation'
const WORKTREE_ID = 'repo-1::/tmp/provider-reattach'
const REKEY_PTY_ID = 'pty-runtime-pane-rekey'
const REKEY_OLD_TAB_ID = '44444444-4444-4444-8444-444444444444'
const REKEY_NEW_TAB_ID = '55555555-5555-4555-8555-555555555555'
const REKEY_OLD_PANE_KEY = makePaneKey(REKEY_OLD_TAB_ID, LEAF_ID)
const REKEY_NEW_PANE_KEY = makePaneKey(REKEY_NEW_TAB_ID, LEAF_ID)

afterEach(() => {
  ptyPaneKey.delete(REKEY_PTY_ID)
  paneKeyPtyId.delete(REKEY_OLD_PANE_KEY)
  paneKeyPtyId.delete(REKEY_NEW_PANE_KEY)
})

type RuntimePtyLaunchIdentity = {
  incarnationId: string | null
  paneKey: string | null
  launchAgent: string | null
  launchToken: string | null
  launchIncarnationId: string | null
}

function getPty(runtime: OrcaRuntimeService, ptyId: string): RuntimePtyLaunchIdentity | undefined {
  return (runtime as unknown as { ptysById: Map<string, RuntimePtyLaunchIdentity> }).ptysById.get(
    ptyId
  )
}

describe('provider reattach launch identity', () => {
  it('restores daemon-owned agent identity without minting renderer authority', () => {
    const runtime = new OrcaRuntimeService(null)

    runtime.registerPty('pty-reattach', WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID,
      providerReattachLaunchIdentity: {
        incarnationId: INCARNATION_ID,
        launchAgent: 'codex'
      }
    })

    expect(getPty(runtime, 'pty-reattach')).toMatchObject({
      incarnationId: INCARNATION_ID,
      paneKey: PANE_KEY,
      launchAgent: 'codex',
      launchToken: null,
      launchIncarnationId: null
    })
  })

  it('rejects provider identity from a different process incarnation', () => {
    const runtime = new OrcaRuntimeService(null)

    runtime.registerPty('pty-mismatched-reattach', WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID,
      providerReattachLaunchIdentity: {
        incarnationId: 'stale-provider-incarnation',
        launchAgent: 'codex'
      }
    })

    expect(getPty(runtime, 'pty-mismatched-reattach')).toMatchObject({
      incarnationId: INCARNATION_ID,
      paneKey: PANE_KEY,
      launchAgent: null,
      launchToken: null,
      launchIncarnationId: null
    })
  })

  it('retires daemon launch identity when the agent command finishes', () => {
    const runtime = new OrcaRuntimeService(null)

    runtime.registerPty('pty-finished-reattach', WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID,
      providerReattachLaunchIdentity: {
        incarnationId: INCARNATION_ID,
        launchAgent: 'codex'
      }
    })
    runtime.emitDaemonPtyTransientFact('pty-finished-reattach', {
      kind: 'command-finished',
      exitCode: 0
    })

    expect(getPty(runtime, 'pty-finished-reattach')).toMatchObject({
      launchAgent: null,
      launchToken: null,
      launchIncarnationId: null
    })
  })

  it('rekeys hook authority when graph registration moves a surviving PTY', () => {
    const onRekey = vi.fn()
    const unregister = registerPaneKeyRekeyListener(onRekey)
    const runtime = new OrcaRuntimeService(null)

    runtime.registerPty(REKEY_PTY_ID, WORKTREE_ID, null, {
      tabId: REKEY_OLD_TAB_ID,
      leafId: LEAF_ID
    })
    runtime.registerPty(REKEY_PTY_ID, WORKTREE_ID, null, {
      tabId: REKEY_NEW_TAB_ID,
      leafId: LEAF_ID
    })

    expect(onRekey).toHaveBeenCalledWith({
      ptyId: REKEY_PTY_ID,
      previousPaneKey: REKEY_OLD_PANE_KEY,
      paneKey: REKEY_NEW_PANE_KEY
    })
    unregister()
  })
})
