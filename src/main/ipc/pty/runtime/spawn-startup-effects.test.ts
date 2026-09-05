import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ptyOwnership, ptyIncarnationById } from '../provider/ownership-state'
import { commitRuntimeStartupEffects } from './spawn-startup-effects'
import { releaseStartupFromRuntimeController } from './deferred-startup'
import { createRuntimePtySpawnState, type RuntimePtySpawnState } from './spawn-state'
import { commitRuntimePtySpawn } from './spawn-commit'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import type { StartupCommandReleaseResult } from '../../../../shared/deferred-startup-release'

const effects = vi.hoisted(() => ({
  note: vi.fn(),
  mark: vi.fn(),
  track: vi.fn(),
  switching: vi.fn(() => false),
  release: vi.fn<() => Promise<StartupCommandReleaseResult>>()
}))
vi.mock('../../../claude-accounts/live-pty-gate', () => ({
  markClaudePtySpawned: effects.mark,
  isClaudeAuthSwitchInProgress: effects.switching
}))
vi.mock('../../../telemetry/client', () => ({ track: effects.track }))
vi.mock('../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../provider/registry', () => ({
  localProvider: {},
  getProvider: vi.fn(),
  getProviderForPty: () => ({ releaseStartupCommand: effects.release })
}))

function prepare(deferred = true): void {
  ptyOwnership.set('pty', null)
  ptyIncarnationById.set('pty', 'incarnation')
  commitRuntimeStartupEffects({
    result: { id: 'pty', incarnationId: 'incarnation' },
    deps: { runtime: { noteTerminalSpawnCommand: effects.note } },
    args: {
      ...(deferred ? { deferredStartupOperationId: 'operation' } : {}),
      telemetry: {
        agent_kind: 'claude-code',
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      }
    },
    launchCommand: 'claude',
    isClaudeLaunch: true
  } as unknown as RuntimePtySpawnState)
}
const release = () => releaseStartupFromRuntimeController('pty', 'incarnation', 'operation')
function expectUnstarted(): void {
  expect(effects.note).not.toHaveBeenCalled()
  expect(effects.mark).not.toHaveBeenCalled()
  expect(effects.track).not.toHaveBeenCalled()
}
function expectStartedOnce(): void {
  expect(effects.note).toHaveBeenCalledExactlyOnceWith('pty', 'claude')
  expect(effects.mark).toHaveBeenCalledExactlyOnceWith('pty')
  expect(effects.track).toHaveBeenCalledExactlyOnceWith('agent_started', {
    agent_kind: 'claude-code',
    launch_source: 'new_workspace_composer',
    request_kind: 'new'
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  ptyOwnership.clear()
  ptyIncarnationById.clear()
  effects.release.mockResolvedValue('accepted')
  effects.switching.mockReturnValue(false)
})

describe('deferred runtime launch effects', () => {
  it('rechecks an account switch that began after preparation before releasing Claude', async () => {
    prepare()
    effects.switching.mockReturnValue(true)
    expect(await release()).toBe('unavailable')
    expect(effects.release).not.toHaveBeenCalled()
    expectUnstarted()
    effects.switching.mockReturnValue(false)
    expect(await release()).toBe('accepted')
    expectStartedOnce()
  })
  it('the actual spawn commit holds effects until accepted release', async () => {
    const ctx = createRuntimePtySpawnState(
      {
        runtime: { noteTerminalSpawnCommand: effects.note },
        sendPtySpawnedToRenderer: vi.fn(),
        options: {}
      } as unknown as PtyRuntimeControllerDeps,
      {
        cols: 80,
        rows: 24,
        command: 'claude',
        deferredStartupOperationId: 'operation',
        telemetry: {
          agent_kind: 'claude-code',
          launch_source: 'new_workspace_composer',
          request_kind: 'new'
        }
      }
    )
    ctx.result = { id: 'pty', incarnationId: 'incarnation' }
    ctx.launchCommand = 'claude'
    ctx.isClaudeLaunch = true
    await commitRuntimePtySpawn(ctx)
    expectUnstarted()
    await release()
    expectStartedOnce()
  })
  it('keeps ordinary startup effects immediate', () => {
    prepare(false)
    expectStartedOnce()
  })
  it('does not turn a pending shell reattach into an agent launch', async () => {
    prepare()
    commitRuntimeStartupEffects({
      result: { id: 'pty', incarnationId: 'incarnation', isReattach: true },
      deps: { runtime: { noteTerminalSpawnCommand: effects.note } },
      args: {},
      launchCommand: 'claude',
      isClaudeLaunch: true
    } as unknown as RuntimePtySpawnState)
    expectUnstarted()
    await release()
    expectStartedOnce()
  })
  it('does not count shell preparation as agent startup', () => {
    prepare()
    expectUnstarted()
  })
  it.each(['pending', 'retired', 'unverifiable'] as const)(
    'honors daemon %s status without a main-process pending record',
    (deferredStartupStatus) => {
      commitRuntimeStartupEffects({
        result: {
          id: 'pty',
          incarnationId: 'incarnation',
          isReattach: true,
          deferredStartupStatus
        },
        deps: { runtime: { noteTerminalSpawnCommand: effects.note } },
        args: {
          telemetry: {
            agent_kind: 'claude-code',
            launch_source: 'new_workspace_composer',
            request_kind: 'new'
          }
        },
        launchCommand: 'claude',
        isClaudeLaunch: true
      } as unknown as RuntimePtySpawnState)
      expectUnstarted()
    }
  )
  it('publishes once after accepted release, including concurrent retries', async () => {
    prepare()
    await Promise.all([release(), release(), release()])
    expectStartedOnce()
  })
  it.each(['unverifiable', 'unavailable', 'identity-mismatch'] as const)(
    'does not publish for %s; a later accepted receipt publishes once',
    async (result) => {
      prepare()
      effects.release.mockResolvedValueOnce(result)
      expect(await release()).toBe(result)
      expectUnstarted()
      await release()
      expectStartedOnce()
    }
  )
  it('allows a lost acknowledgement to be retried without counting the failed attempt', async () => {
    prepare()
    effects.release.mockRejectedValueOnce(new Error('connection lost'))
    await expect(release()).rejects.toThrow('connection lost')
    expectUnstarted()
    await release()
    await release()
    expectStartedOnce()
  })
  it('drops a retired command without publishing effects', async () => {
    prepare()
    effects.release.mockResolvedValueOnce('retired')
    await release()
    await release()
    expectUnstarted()
  })
  it.each(['delete', 'clear', 'clearDeferredStartup'] as const)(
    'ownership %s bounds the pending record and fences an in-flight acknowledgement',
    async (cleanup) => {
      prepare()
      let acknowledge!: (value: StartupCommandReleaseResult) => void
      effects.release.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            acknowledge = resolve
          })
      )
      const pending = release()
      ptyOwnership[cleanup]('pty')
      acknowledge('accepted')
      await pending
      expectUnstarted()
    }
  )
  it('does not publish into a replacement process incarnation', async () => {
    prepare()
    let acknowledge!: (value: StartupCommandReleaseResult) => void
    effects.release.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve
        })
    )
    const pending = release()
    ptyIncarnationById.set('pty', 'replacement')
    acknowledge('accepted')
    await pending
    expectUnstarted()
  })
})
