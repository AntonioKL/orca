import { describe, expect, it, vi } from 'vitest'
import { verifyHostedIosNativeAlertJourney } from '../../scripts/hosted-ios-native-alert-journey.mjs'

describe('hosted iOS native Alert journey', () => {
  it('presents an OS alert, correlates its action, and returns to workspaces', async () => {
    const workspaceDocument = { href: 'orca-mobile-web://build/h/host' }
    const sessionDocument = { href: 'orca-mobile-web://build/h/host/session/workspace' }
    const returnedDocument = { href: 'orca-mobile-web://build/h/host' }
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ started: true }))
      .mockResolvedValueOnce(JSON.stringify({ posted: true }))
      .mockResolvedValueOnce(
        JSON.stringify({ status: 'success', payload: { kind: 'button', buttonIndex: 0 } })
      )
    const waitForDocument = vi
      .fn()
      .mockResolvedValueOnce(sessionDocument)
      .mockResolvedValueOnce(returnedDocument)
    const activateWorkspace = vi.fn().mockResolvedValue(undefined)
    const activateControl = vi.fn().mockResolvedValue(undefined)
    const waitForLabel = vi.fn().mockResolvedValue({ frame: { x: 0, y: 0, width: 1, height: 1 } })
    const tapControl = vi.fn().mockResolvedValue({ x: 0.5, y: 0.5 })
    const waitForLabelToDisappear = vi.fn().mockResolvedValue(undefined)
    const tapPoint = vi.fn().mockResolvedValue(undefined)

    const result = await verifyHostedIosNativeAlertJourney(
      {
        discoveryUrl: 'http://127.0.0.1:9222',
        emulator: { deviceUdid: 'simulator' },
        expectedWorkspace: 'mobile-rearch',
        timeoutMs: 30_000,
        workspaceDocument
      },
      {
        activateControl,
        activateWorkspace,
        evaluate,
        tapControl,
        tapPoint,
        waitForDocument,
        waitForLabel,
        waitForLabelToDisappear
      }
    )

    expect(tapPoint).toHaveBeenCalledWith({ deviceUdid: 'simulator' }, { x: 0.5, y: 0.6 })
    expect(tapPoint.mock.invocationCallOrder[0]).toBeLessThan(evaluate.mock.invocationCallOrder[1]!)
    expect(tapControl).toHaveBeenCalledWith({ deviceUdid: 'simulator' }, 'Keep editing', 30_000)
    expect(activateControl).toHaveBeenCalledWith(sessionDocument, {
      kind: 'label',
      value: 'Back to worktrees'
    })
    expect(result).toEqual({
      evidence: {
        button: { x: 0.5, y: 0.5 },
        buttonIndex: 0,
        presentation: 'native',
        title: { x: 0, y: 0, width: 1, height: 1 }
      },
      workspaceDocument: returnedDocument
    })
  })
})
