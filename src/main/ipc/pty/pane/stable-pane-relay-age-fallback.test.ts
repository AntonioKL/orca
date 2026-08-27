import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { Store } from '../../../persistence'
import type { IPtyProvider, PtySpawnOptions } from '../../../providers/types'
import { noCodexResumeLaunch } from '../host-env/codex-resume'
import { registerSshPtyProvider, unregisterSshPtyProvider } from '../provider/registry'
import { spawnPtyFromRuntimeController } from '../runtime/spawn'
import { adoptStablePane } from './adopt-stable'
import { resolveStablePaneOwner, spawnForStablePane } from './stable-owner'

const NOW = 10_000
const BINDING_CREATED_AT = 1_000
const BINDING_AGE = NOW - BINDING_CREATED_AT
const WORKTREE_ID = 'worktree-1'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const CONNECTION_ID = 'ssh-1'
const APP_PTY_ID = `ssh:${CONNECTION_ID}@@pty-1`

type AbsenceFallbackResult = Awaited<ReturnType<typeof spawnForStablePane>> & {
  absenceVerdict: { status: 'live' | 'unverifiable' | 'exited' }
}

function createStore(): Store {
  let session = {
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          worktreeId: WORKTREE_ID,
          ptyId: APP_PTY_ID,
          createdAt: BINDING_CREATED_AT
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: APP_PTY_ID }
      }
    }
  } as unknown as WorkspaceSessionState
  return {
    getWorkspaceSession: () => session,
    setWorkspaceSession: (nextSession: WorkspaceSessionState) => {
      session = nextSession as typeof session
    },
    flushOrThrow: vi.fn(),
    getSshRemotePtyLeases: () => [
      {
        targetId: CONNECTION_ID,
        ptyId: 'pty-1',
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        leafId: LEAF_ID,
        state: 'detached',
        createdAt: BINDING_CREATED_AT,
        updatedAt: BINDING_CREATED_AT
      }
    ]
  } as unknown as Store
}

function createProvider(relayStatus: unknown): {
  provider: IPtyProvider
  requestHostRpc: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
} {
  const spawn = vi
    .fn()
    .mockRejectedValueOnce(new Error('PTY "pty-1" not found'))
    .mockResolvedValueOnce({ id: `ssh:${CONNECTION_ID}@@pty-2`, isReattach: false })
  const requestHostRpc = vi.fn().mockResolvedValue(relayStatus)
  return {
    provider: { spawn, requestHostRpc } as unknown as IPtyProvider,
    requestHostRpc,
    spawn
  }
}

const STARTUP_INTENT: PtySpawnOptions = {
  cols: 80,
  rows: 24,
  command: 'codex resume session-1',
  commandDelivery: 'provider',
  startupCommandDelivery: 'shell-ready',
  launchAgent: 'codex',
  startupIngress: { colors: { foreground: 'rgb:ffff/ffff/ffff' }, deadlineMs: 1_000 },
  env: { ORCA_AGENT_LAUNCH_TOKEN: 'launch-1', KEEP_ME: 'yes' },
  onPtySpawnCommitted: vi.fn(),
  agentSessionCreateOperationId: 'create-1'
}

async function runFallback(relayStatus: unknown): Promise<{
  result: AbsenceFallbackResult
  requestHostRpc: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
}> {
  const store = createStore()
  const owner = resolveStablePaneOwner(undefined, store, PANE_KEY, WORKTREE_ID, CONNECTION_ID)
  expect(owner).not.toBeNull()
  const { provider, requestHostRpc, spawn } = createProvider(relayStatus)
  const result = (await spawnForStablePane({
    runtime: undefined,
    store,
    provider,
    spawnOptions: STARTUP_INTENT,
    owner,
    connectionId: CONNECTION_ID,
    resolveOwner: () => null
  })) as AbsenceFallbackResult
  return { result, requestHostRpc, spawn }
}

describe('stable pane relay-age-aware absence fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    unregisterSshPtyProvider(CONNECTION_ID)
    vi.useRealTimers()
  })

  it('degrades a stale binding answered by a younger live relay to unverifiable', async () => {
    const { result, requestHostRpc, spawn } = await runFallback({
      pid: 42,
      uptimeMs: BINDING_AGE - 1
    })

    expect(result.absenceVerdict.status).toBe('unverifiable')
    expect(requestHostRpc).toHaveBeenCalledWith('relay.status', {}, expect.any(Object))
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1]?.[0]).toMatchObject({
      command: undefined,
      commandDelivery: undefined,
      startupCommandDelivery: undefined,
      launchAgent: undefined,
      startupIngress: STARTUP_INTENT.startupIngress,
      env: { KEEP_ME: 'yes' },
      onPtySpawnCommitted: STARTUP_INTENT.onPtySpawnCommitted,
      agentSessionCreateOperationId: undefined
    })
  })

  it.each([
    ['exactly as old as the binding', BINDING_AGE],
    ['one millisecond older than the binding', BINDING_AGE + 1]
  ])('keeps genuine positive absence exited when the relay is %s', async (_label, uptimeMs) => {
    const { result, spawn } = await runFallback({ pid: 42, uptimeMs })

    expect(result.absenceVerdict.status).toBe('exited')
    expect(spawn.mock.calls[1]?.[0]).toMatchObject({
      command: STARTUP_INTENT.command,
      launchAgent: STARTUP_INTENT.launchAgent
    })
  })

  it('keeps an older host without relay age compatible with the prior fallback', async () => {
    const { result, spawn } = await runFallback({ pid: 42 })

    expect(result.absenceVerdict.status).toBe('exited')
    expect(spawn.mock.calls[1]?.[0]).toMatchObject({
      command: STARTUP_INTENT.command,
      launchAgent: STARTUP_INTENT.launchAgent
    })
  })

  it('carries an early adoption verdict into the later full spawn', async () => {
    const store = createStore()
    const { provider, spawn } = createProvider({ pid: 42, uptimeMs: BINDING_AGE - 1 })
    registerSshPtyProvider(CONNECTION_ID, provider)

    const adoption = await adoptStablePane(undefined, store, {
      cols: 80,
      rows: 24,
      connectionId: CONNECTION_ID,
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: LEAF_ID
    })
    expect(adoption?.result).toBeNull()
    if (!adoption || adoption.result !== null) {
      throw new Error('expected an absence outcome')
    }
    expect(adoption.absenceVerdict.status).toBe('unverifiable')

    const result = await spawnForStablePane({
      runtime: undefined,
      store,
      provider,
      spawnOptions: STARTUP_INTENT,
      owner: null,
      connectionId: CONNECTION_ID,
      absenceVerdict: adoption.absenceVerdict
    })

    expect(result.absenceVerdict?.status).toBe('unverifiable')
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1]?.[0]).toMatchObject({
      command: undefined,
      launchAgent: undefined,
      startupIngress: STARTUP_INTENT.startupIngress,
      env: { KEEP_ME: 'yes' }
    })
  })

  it('suppresses runtime agent-session claims after an unverifiable early adoption', async () => {
    const spawn = vi.fn(async (_options: PtySpawnOptions) => ({
      id: `ssh:${CONNECTION_ID}@@pty-2`
    }))
    registerSshPtyProvider(CONNECTION_ID, {
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)

    const result = await spawnPtyFromRuntimeController(
      {
        assertFolderWorkspacePtyPathUsable: vi.fn(),
        resolvePtySpawnStartupCwd: (_worktreeId: string | undefined, cwd: string | undefined) =>
          cwd,
        prepareCodexResumeHome: vi.fn(() => null),
        noCodexResumeLaunch,
        resolveCodexResumeLaunch: vi.fn(),
        reconcileSharedRuntimeResumeHome: vi.fn(),
        stripSequencedStartupResumeArgv: (env: Record<string, string> | undefined) => env,
        getLocalPtyStartupPromise: vi.fn(() => undefined),
        trustedTerminalHandleEnv: new Set(),
        sendPtySpawnedToRenderer: vi.fn()
      } as never,
      {
        cols: 80,
        rows: 24,
        connectionId: CONNECTION_ID,
        command: STARTUP_INTENT.command,
        commandDelivery: STARTUP_INTENT.commandDelivery,
        startupCommandDelivery: STARTUP_INTENT.startupCommandDelivery,
        launchAgent: STARTUP_INTENT.launchAgent,
        env: STARTUP_INTENT.env,
        agentSessionEnsure: {
          claim: { identityDigest: 'claim-digest' },
          surface: {
            worktreeId: WORKTREE_ID,
            tabId: TAB_ID,
            leafId: LEAF_ID,
            terminalHandle: 'term-1'
          }
        },
        stablePaneAbsenceVerdict: {
          status: 'unverifiable',
          reason: 'the answering SSH relay is younger than the persisted PTY binding'
        }
      } as never
    )

    expect(result.agentStartupSuppressed).toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      command: undefined,
      commandDelivery: undefined,
      startupCommandDelivery: undefined,
      launchAgent: undefined,
      agentSessionEnsure: undefined,
      env: { KEEP_ME: 'yes' }
    })
  })
})
