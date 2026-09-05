import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequestedWorktree } from './create-requested-worktree'
import { makeRequest } from './worktree-creation-request.test-fixture'

const { createWorktree } = vi.hoisted(() => ({ createWorktree: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ createWorktree }) }
}))
vi.mock('@/lib/worktree-draft-startup-view-mode', () => ({
  resolveBackendDraftStartup: (request: { startup?: unknown }) => request.startup
}))

beforeEach(() => vi.clearAllMocks())

describe('durable composer creation launch boundary', () => {
  it.each(['command', 'draft'] as const)(
    'withholds agent %s execution until Create while retaining workspace metadata',
    async (delivery) => {
      const request = makeRequest({
        agent: 'codex',
        startup: delivery === 'command' ? { command: 'codex', launchAgent: 'codex' } : undefined,
        launchDraftPrompt: 'Investigate this task',
        startupPlan: {
          agent: 'codex',
          launchCommand: 'codex',
          expectedProcess: 'codex',
          followupPrompt: null,
          launchConfig: { agentArgs: '', agentEnv: {} }
        }
      })
      const snapshot = structuredClone(request)
      await createRequestedWorktree('reservation', request, true)
      const args = createWorktree.mock.calls[0]
      expect(args[10]).toBe('codex')
      expect(args[16]).toBeUndefined()
      expect(args[25]).not.toHaveProperty('startupDraft')
      expect(request).toEqual(snapshot)
    }
  )

  it('preserves ordinary backend agent launch', async () => {
    const startup = { command: 'codex', launchAgent: 'codex' as const }
    await createRequestedWorktree('submit', makeRequest({ agent: 'codex', startup }))
    expect(createWorktree.mock.calls[0][16]).toEqual(startup)
  })

  it('preserves ordinary host-owned draft launch', async () => {
    await createRequestedWorktree(
      'submit',
      makeRequest({ agent: 'codex', launchDraftPrompt: 'Unsent task' })
    )
    expect(createWorktree.mock.calls[0][25]).toMatchObject({ startupDraft: 'Unsent task' })
  })

  it('continues warming blank shells without selecting them', async () => {
    await createRequestedWorktree(
      'reservation',
      makeRequest({ startup: { command: '', env: { PROJECT: 'fixture' } } }),
      true
    )
    expect(createWorktree.mock.calls[0][16]).toEqual({
      command: '',
      env: { PROJECT: 'fixture' },
      activate: false
    })
  })
})
