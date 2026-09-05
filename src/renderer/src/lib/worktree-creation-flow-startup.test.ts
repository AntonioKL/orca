import { describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import { buildWorktreeCreationStartupOpt } from './worktree-creation-flow-startup'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ getActiveRuntimeTarget: vi.fn() }))

const blankRequest: WorktreeCreationRequest = {
  repoId: 'ssh-repo',
  name: 'new-workspace',
  setupDecision: 'inherit',
  agent: null,
  pendingFirstAgentMessageRename: false,
  note: '',
  startupPlan: null,
  quickPrompt: '',
  quickTelemetry: null
}

describe('new-workspace blank terminal intent', () => {
  it('preserves an explicit blank startup when the backend did not spawn it', () => {
    expect(buildWorktreeCreationStartupOpt(blankRequest, false)).toEqual({ command: '' })
  })

  it('adopts a backend terminal without requesting another one', () => {
    expect(buildWorktreeCreationStartupOpt(blankRequest, true)).toBeUndefined()
  })

  it('lets configured default tabs retain their startup commands', () => {
    expect(buildWorktreeCreationStartupOpt(blankRequest, false, true)).toBeUndefined()
  })

  it('does not turn a missing agent launch plan into a blank terminal', () => {
    expect(
      buildWorktreeCreationStartupOpt({ ...blankRequest, agent: 'claude' }, false)
    ).toBeUndefined()
  })
})
