import { describe, expect, it } from 'vitest'
import type { AutomationPrecheckResult, AutomationRun } from '../../../../shared/automations-types'
import { getAutomationRunContent, getAutomationRunNotice } from './automation-run-content'

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    title: 'Run 1',
    scheduledFor: 1,
    status: 'completed',
    trigger: 'scheduled',
    workspaceId: 'wt-1',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab-1',
    terminalPaneKey: 'tab-1:pane-1',
    terminalPtyId: 'pty-1',
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 1,
    dispatchedAt: 1,
    createdAt: 1,
    ...overrides
  }
}

function makePassingPrecheck(stdout: string): AutomationPrecheckResult {
  return {
    command: 'orca status --json',
    exitCode: 0,
    timedOut: false,
    durationMs: 210,
    stdout,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    error: null,
    startedAt: 1,
    completedAt: 2
  }
}

describe('getAutomationRunNotice', () => {
  it('surfaces the run error even when a passing precheck fills the body', () => {
    const run = makeRun({
      status: 'dispatch_failed',
      observationVerdict: 'unverifiable',
      precheckResult: makePassingPrecheck('{"id":"local-status","ok":true}'),
      error: 'Orca stopped watching this run before it reported completion.'
    })
    // Why this pairing: the precheck stdout used to be the only thing the run page
    // rendered, so the reason was invisible on exactly the runs that needed it.
    expect(getAutomationRunContent(run)).toContain('local-status')
    expect(getAutomationRunNotice(run)).toEqual({
      text: 'Orca stopped watching this run before it reported completion.',
      tone: 'neutral'
    })
  })

  it('marks only an observed failure with the error tone', () => {
    expect(
      getAutomationRunNotice(
        makeRun({ status: 'dispatch_failed', error: 'Automation process exited with code 1.' })
      )
    ).toEqual({ text: 'Automation process exited with code 1.', tone: 'error' })
  })

  it('returns nothing for a run that ended without a reason', () => {
    expect(getAutomationRunNotice(makeRun({ error: '  ' }))).toBeNull()
    expect(getAutomationRunNotice(makeRun())).toBeNull()
  })
})

describe('getAutomationRunContent', () => {
  it('prefers the saved output snapshot over the precheck output', () => {
    expect(
      getAutomationRunContent(
        makeRun({
          outputSnapshot: {
            format: 'plain_text',
            content: '# Triage report',
            capturedAt: 3,
            truncated: false
          },
          precheckResult: makePassingPrecheck('{"ok":true}')
        })
      )
    ).toBe('# Triage report')
  })

  it('no longer repeats the error the notice already carries', () => {
    expect(getAutomationRunContent(makeRun({ status: 'dispatch_failed', error: 'boom' }))).toBe(
      'No output content available.'
    )
  })
})
