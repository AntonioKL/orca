import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../../../providers/types'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import {
  assertFreshDeferredStartup,
  providerSupportsDeferredStartup,
  releaseStartupFromRuntimeController,
  supportsDeferredStartupFromRuntimeController
} from './deferred-startup'

const registry = vi.hoisted(() => ({ selected: vi.fn(), owner: vi.fn() }))
vi.mock('../provider/registry', () => ({
  getProvider: registry.selected,
  getProviderForPty: registry.owner
}))

function provider() {
  return {
    supportsDeferredStartupCommands: vi.fn(() => true),
    releaseStartupCommand: vi.fn(async () => 'accepted' as const)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ptyOwnership.clear()
  ptyIncarnationById.clear()
})

describe('deferred runtime startup admission', () => {
  const args = { cols: 80, rows: 24, command: 'codex', deferredStartupOperationId: 'operation' }
  it('requires both provider capability and a release contract', async () => {
    const supported = provider()
    registry.selected.mockReturnValue(supported)
    await expect(supportsDeferredStartupFromRuntimeController('ssh-target')).resolves.toBe(true)
    expect(registry.selected).toHaveBeenCalledWith('ssh-target')
    expect(
      providerSupportsDeferredStartup({
        supportsDeferredStartupCommands: () => true
      } as IPtyProvider)
    ).toBe(false)
    expect(
      providerSupportsDeferredStartup({
        releaseStartupCommand: supported.releaseStartupCommand
      } as unknown as IPtyProvider)
    ).toBe(false)
  })
  it.each([
    { commandDelivery: 'renderer' as const },
    { sessionId: 'existing' },
    { adoptedStablePane: {} as never },
    { agentSessionEnsure: {} as never },
    { agentSessionCreateOperationId: 'claimed' }
  ])('refuses existing or alternate launch ownership: %j', (extra) => {
    expect(() => assertFreshDeferredStartup({ ...args, ...extra })).toThrow(
      'deferred_startup_requires_fresh'
    )
  })
  it('refuses a concurrent pane owner and malformed preparation', () => {
    expect(() => assertFreshDeferredStartup(args, {})).toThrow('deferred_startup_requires_fresh')
    expect(() => assertFreshDeferredStartup({ ...args, command: '' })).toThrow('requires_command')
    expect(() => assertFreshDeferredStartup({ ...args, deferredStartupOperationId: ' ' })).toThrow(
      'requires_command'
    )
    expect(() => assertFreshDeferredStartup(args)).not.toThrow()
    expect(() =>
      assertFreshDeferredStartup({ cols: 80, rows: 24, sessionId: 'ordinary' }, {})
    ).not.toThrow()
  })
})

describe('deferred runtime release ownership', () => {
  it('does not route an unknown local id to the selected provider', async () => {
    await expect(
      releaseStartupFromRuntimeController('unknown', 'incarnation', 'operation')
    ).resolves.toBe('unavailable')
    expect(registry.owner).not.toHaveBeenCalled()
    expect(registry.selected).not.toHaveBeenCalled()
  })
  it('passes exact identity to the recorded owner', async () => {
    const owner = provider()
    ptyOwnership.set('pty', 'ssh-target')
    ptyIncarnationById.set('pty', 'incarnation')
    registry.owner.mockReturnValue(owner)
    await expect(
      releaseStartupFromRuntimeController('pty', 'incarnation', 'operation')
    ).resolves.toBe('accepted')
    expect(owner.releaseStartupCommand).toHaveBeenCalledExactlyOnceWith(
      'pty',
      'incarnation',
      'operation'
    )
    expect(registry.selected).not.toHaveBeenCalled()
  })
  it('releases an existing owner even when fresh preparation is unsupported', async () => {
    const owner = provider()
    owner.supportsDeferredStartupCommands.mockReturnValue(false)
    ptyOwnership.set('pty', null)
    registry.owner.mockReturnValue(owner)
    await expect(
      releaseStartupFromRuntimeController('pty', 'incarnation', 'operation')
    ).resolves.toBe('accepted')
    expect(owner.supportsDeferredStartupCommands).not.toHaveBeenCalled()
  })
  it('rejects an already replaced incarnation before dispatch', async () => {
    ptyOwnership.set('pty', null)
    ptyIncarnationById.set('pty', 'new-incarnation')
    await expect(
      releaseStartupFromRuntimeController('pty', 'old-incarnation', 'operation')
    ).resolves.toBe('identity-mismatch')
    expect(registry.owner).not.toHaveBeenCalled()
  })
  it('preserves uncertainty and transport failure without retrying', async () => {
    const release = vi
      .fn()
      .mockResolvedValueOnce('unverifiable')
      .mockRejectedValueOnce(new Error('connection lost'))
    ptyOwnership.set('pty', null)
    registry.owner.mockReturnValue({ ...provider(), releaseStartupCommand: release })
    await expect(
      releaseStartupFromRuntimeController('pty', 'incarnation', 'operation')
    ).resolves.toBe('unverifiable')
    await expect(
      releaseStartupFromRuntimeController('pty', 'incarnation', 'operation')
    ).rejects.toThrow('connection lost')
    expect(release).toHaveBeenCalledTimes(2)
  })
  it('preserves a disconnected owner error without falling back', async () => {
    ptyOwnership.set('pty', 'ssh-target')
    registry.owner.mockImplementationOnce(() => {
      throw new Error('owner disconnected')
    })
    await expect(
      releaseStartupFromRuntimeController('pty', 'incarnation', 'operation')
    ).rejects.toThrow('owner disconnected')
    expect(registry.selected).not.toHaveBeenCalled()
  })
})
