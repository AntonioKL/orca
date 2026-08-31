import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../store/types'

const getRuntimeEnvironmentIdForWorktree = vi.hoisted(() => vi.fn())

vi.mock('../lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree
}))

import { getStructuredAgentSessionTarget } from './structured-agent-session-target'

describe('getStructuredAgentSessionTarget', () => {
  it('routes runtime-owned worktrees to their paired environment', () => {
    getRuntimeEnvironmentIdForWorktree.mockReturnValue('paired-host')

    expect(getStructuredAgentSessionTarget({} as AppState, 'worktree-1')).toEqual({
      kind: 'environment',
      environmentId: 'paired-host'
    })
  })

  it('keeps local and SSH worktrees on the local structured surface', () => {
    getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)

    expect(getStructuredAgentSessionTarget({} as AppState, 'worktree-1')).toEqual({
      kind: 'local'
    })
  })
})
