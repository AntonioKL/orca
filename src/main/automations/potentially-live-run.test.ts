import { describe, expect, it } from 'vitest'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { findPotentiallyLiveAutomationRun } from './potentially-live-run'

const automation = {
  id: 'automation-2',
  workspaceMode: 'existing',
  workspaceId: 'workspace-1'
} as Automation

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    workspaceId: 'workspace-1',
    status: 'dispatched',
    ...overrides
  } as AutomationRun
}

describe('findPotentiallyLiveAutomationRun', () => {
  it('finds an in-flight run from another automation in the same workspace', () => {
    expect(findPotentiallyLiveAutomationRun(automation, 'current', [run()])?.id).toBe('run-1')
  })

  it('keeps an additive unverifiable verdict potentially live after a legacy final status', () => {
    expect(
      findPotentiallyLiveAutomationRun(automation, 'current', [
        run({ status: 'dispatch_failed', observationVerdict: 'unverifiable' })
      ])?.id
    ).toBe('run-1')
  })

  it('does not infer liveness from terminal identity after an observed failure', () => {
    expect(
      findPotentiallyLiveAutomationRun(automation, 'current', [
        run({
          status: 'dispatch_failed',
          terminalSessionId: 'tab-1',
          terminalPtyId: 'pty-1'
        })
      ])
    ).toBeNull()
  })

  it('recognizes a legacy completion-observer loss by its transport error', () => {
    expect(
      findPotentiallyLiveAutomationRun(automation, 'current', [
        run({ status: 'dispatch_failed', error: 'terminal_handle_stale' })
      ])?.id
    ).toBe('run-1')
  })

  it('does not treat a persisted pre-dispatch row as live', () => {
    expect(
      findPotentiallyLiveAutomationRun(automation, 'current', [run({ status: 'pending' })])
    ).toBeNull()
  })

  it('does not block new-per-run workspaces', () => {
    expect(
      findPotentiallyLiveAutomationRun({ ...automation, workspaceMode: 'new_per_run' }, 'current', [
        run({ observationVerdict: 'unverifiable' })
      ])
    ).toBeNull()
  })
})
