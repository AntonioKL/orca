import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { inspectHooksTrust } from './ensure-hooks-confirmed'
import { hashOrcaHookScript } from './orca-hook-trust'

const { checkHooks } = vi.hoisted(() => ({ checkHooks: vi.fn() }))
vi.mock('@/runtime/runtime-hooks-client', () => ({
  checkRuntimeHooks: checkHooks,
  readRuntimeIssueCommand: vi.fn()
}))

function makeState(): AppState {
  return {
    repos: [{ id: 'repo', path: '/repo' }],
    trustedOrcaHooks: {},
    settings: null,
    openModal: vi.fn(() => {
      throw new Error('Inspection must never replace the composer')
    })
  } as unknown as AppState
}

describe('noninteractive composer hook trust', () => {
  beforeEach(() => checkHooks.mockReset())

  it('requires confirmation for unapproved setup and leaves the composer alone', async () => {
    const state = makeState()
    checkHooks.mockResolvedValue({ hooks: { scripts: { setup: 'pnpm install' } } })
    await expect(inspectHooksTrust(state, 'repo', 'setup')).resolves.toBe('confirmation-required')
    expect(state.openModal).not.toHaveBeenCalled()
  })

  it('permits approved content but requires confirmation when default tab commands change', async () => {
    const state = makeState()
    state.trustedOrcaHooks.repo = {
      setup: { contentHash: await hashOrcaHookScript('pnpm install'), approvedAt: 1 }
    }
    checkHooks.mockResolvedValue({ hooks: { scripts: { setup: 'pnpm install' } } })
    await expect(inspectHooksTrust(state, 'repo', 'setup')).resolves.toBe('run')
    checkHooks.mockResolvedValue({
      hooks: { scripts: { setup: 'pnpm install' }, defaultTabs: [{ command: 'pnpm dev' }] }
    })
    await expect(inspectHooksTrust(state, 'repo', 'setup')).resolves.toBe('confirmation-required')
  })

  it('does not turn failed inspection into permission to prepare', async () => {
    checkHooks.mockRejectedValueOnce(new Error('disconnected'))
    await expect(inspectHooksTrust(makeState(), 'repo', 'setup')).resolves.toBe('skip')
    checkHooks.mockResolvedValueOnce({ status: 'error', hooks: null })
    await expect(inspectHooksTrust(makeState(), 'repo', 'setup')).resolves.toBe('skip')
  })

  it('inspects the execution owner even when another runtime is focused', async () => {
    const state = makeState()
    state.settings = { activeRuntimeEnvironmentId: 'elsewhere' } as AppState['settings']
    checkHooks.mockResolvedValue({ hooks: null })
    await expect(inspectHooksTrust(state, 'repo', 'setup', 'runtime:owner')).resolves.toBe('run')
    expect(checkHooks).toHaveBeenCalledWith(
      expect.objectContaining({ activeRuntimeEnvironmentId: 'owner' }),
      'repo',
      'runtime:owner'
    )
  })

  it('does not reuse repo-wide trust across duplicate repository identities', async () => {
    const state = makeState()
    state.repos = [state.repos[0], { ...state.repos[0], connectionId: 'remote' }]
    state.trustedOrcaHooks.repo = { all: { approvedAt: 1 } }
    checkHooks.mockResolvedValue({ hooks: { scripts: { setup: 'untrusted' } } })
    await expect(inspectHooksTrust(state, 'repo', 'setup')).resolves.toBe('confirmation-required')
  })

  it('does not inspect canceled composer work', async () => {
    await expect(
      inspectHooksTrust(makeState(), 'repo', 'setup', undefined, undefined, () => true)
    ).resolves.toBe('skip')
    expect(checkHooks).not.toHaveBeenCalled()
  })
})
