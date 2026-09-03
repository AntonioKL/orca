import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationDispatchResult, AutomationRun } from '../../shared/automations-types'
import type { HeadlessAutomationDispatchLaunch } from './headless-dispatch'
import { observeHeadlessAutomationCompletion } from './headless-run-completion'

const target = {
  workspaceId: 'workspace-1',
  workspaceDisplayName: 'Workspace',
  terminalSessionId: 'tab-1',
  terminalPaneKey: 'pane-1',
  terminalPtyId: 'pty-1'
}

function observe(completion: HeadlessAutomationDispatchLaunch['completion']) {
  const markDispatchResult = vi.fn(
    async (result: AutomationDispatchResult) => result as unknown as AutomationRun
  )
  observeHeadlessAutomationCompletion({
    run: { id: 'run-1' } as AutomationRun,
    launch: { ...target, completion },
    target,
    precheckResult: null,
    markDispatchResult
  })
  return markDispatchResult
}

afterEach(() => vi.restoreAllMocks())

describe('observeHeadlessAutomationCompletion', () => {
  it('records an unverifiable run with dispatch_failed status', async () => {
    const mark = observe(
      Promise.resolve({
        status: 'dispatch_failed',
        observationVerdict: 'unverifiable'
      })
    )
    await vi.waitFor(() =>
      expect(mark).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'dispatch_failed',
          observationVerdict: 'unverifiable'
        })
      )
    )
  })

  it('leaves an observed failure final', async () => {
    const mark = observe(Promise.resolve({ status: 'dispatch_failed', error: 'Exited.' }))
    await vi.waitFor(() =>
      expect(mark).toHaveBeenCalledWith(expect.objectContaining({ status: 'dispatch_failed' }))
    )
  })

  it('treats observer rejection as unverifiable without leaking transport tokens', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mark = observe(Promise.reject(new Error('terminal_handle_stale')))
    await vi.waitFor(() =>
      expect(mark).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'dispatch_failed',
          observationVerdict: 'unverifiable',
          error: 'Orca stopped watching this run before it reported completion.'
        })
      )
    )
  })

  it('keeps positive terminal exit evidence final', async () => {
    const mark = observe(Promise.reject(new Error('terminal_exited')))
    await vi.waitFor(() =>
      expect(mark).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'dispatch_failed',
          observationVerdict: null,
          error: 'Automation terminal exited before the agent reported completion.'
        })
      )
    )
  })

  it('does not reinterpret persistence failure as observation loss', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const markDispatchResult = vi.fn().mockRejectedValue(new Error('Automation run not found.'))
    observeHeadlessAutomationCompletion({
      run: { id: 'run-1' } as AutomationRun,
      launch: { ...target, completion: Promise.resolve({ status: 'completed' }) },
      target,
      precheckResult: null,
      markDispatchResult
    })
    await vi.waitFor(() => expect(markDispatchResult).toHaveBeenCalledTimes(1))
    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' })
    )
  })
})
