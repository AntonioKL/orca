import { describe, expect, it } from 'vitest'
import {
  buildLocalWorktreeCreateArgs,
  buildRuntimeWorktreeCreateParams
} from './worktree-create-payload'

describe('worktree startup activation intent', () => {
  it.each(['', 'codex'])(
    'preserves background intent for command %j on both transports',
    (command) => {
      const startup = { command, activate: false, env: { PROJECT: 'fixture' } }
      const request = { repoId: 'repo', name: 'draft', startup }
      const attempt = { name: 'draft' }
      expect(buildLocalWorktreeCreateArgs(request, attempt).startup).toEqual(startup)
      expect(buildRuntimeWorktreeCreateParams(request, attempt)).toMatchObject({
        startupCommand: command,
        startupEnv: startup.env,
        startupActivate: false,
        activate: false
      })
    }
  )

  it('keeps ordinary foreground creation compatible when activation intent is absent', () => {
    const payload = buildRuntimeWorktreeCreateParams(
      { repoId: 'repo', name: 'draft', startup: { command: 'codex' } },
      { name: 'draft' }
    )
    expect(payload).toMatchObject({ startupCommand: 'codex', activate: true })
    expect(payload).not.toHaveProperty('startupActivate')
  })

  it('does not synthesize startup or activation for checkout-only preparation', () => {
    const payload = buildRuntimeWorktreeCreateParams(
      { repoId: 'repo', name: 'draft', createdWithAgent: 'codex' },
      { name: 'draft' }
    )
    expect(payload).not.toHaveProperty('startupCommand')
    expect(payload).not.toHaveProperty('startupActivate')
    expect(payload).not.toHaveProperty('activate')
  })
})
