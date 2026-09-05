import { describe, expect, it } from 'vitest'
import { buildQuickComposerStartup, type QuickComposerStartupInput } from './quick-startup-plan'

const blankInput: QuickComposerStartupInput = {
  agent: null,
  prompt: '',
  draftPrompt: null,
  settings: null,
  repoConnectionId: null,
  platform: 'darwin',
  shell: 'posix',
  isRemote: false,
  telemetrySource: 'command_palette'
}

describe('quick composer backend shell startup', () => {
  it('starts a local blank shell without an agent plan or agent telemetry', () => {
    expect(buildQuickComposerStartup(blankInput)).toEqual({
      startupPlan: null,
      backendStartup: { command: '' },
      telemetry: null
    })
  })

  it('leaves remote blank-shell startup with the existing host path', () => {
    expect(
      buildQuickComposerStartup({ ...blankInput, isRemote: true }).backendStartup
    ).toBeUndefined()
  })

  it('does not replace an agent launch with an empty shell', () => {
    const result = buildQuickComposerStartup({ ...blankInput, agent: 'claude' })
    expect(result.startupPlan).not.toBeNull()
    expect(result.backendStartup?.command).toContain('claude')
  })
})
