import { describe, expect, it } from 'vitest'
import {
  TERMINAL_CLOSE_DECISION_BY_LIVENESS,
  terminalCloseDecision,
  terminalCloseLivenessFromInspection
} from './terminal-close-liveness'

describe('terminal close liveness policy', () => {
  it.each([
    ['live', 'prompt'],
    ['unverifiable', 'prompt'],
    ['exited', 'close']
  ] as const)('maps %s to the shared %s decision', (liveness, expected) => {
    expect(terminalCloseDecision(liveness)).toBe(expected)
    expect(TERMINAL_CLOSE_DECISION_BY_LIVENESS[liveness]).toBe(expected)
  })

  it('does not turn an unavailable or missing inspection into an exited verdict', () => {
    expect(terminalCloseLivenessFromInspection(undefined)).toBe('unverifiable')
    expect(
      terminalCloseLivenessFromInspection({ hasChildProcesses: false, unavailable: true })
    ).toBe('unverifiable')
  })

  it('treats a confirmed child process as live and a complete idle response as exited', () => {
    expect(terminalCloseLivenessFromInspection({ hasChildProcesses: true })).toBe('live')
    expect(terminalCloseLivenessFromInspection({ hasChildProcesses: false })).toBe('exited')
  })

  it('lets composite host evidence poison the close even when the legacy scalar is false', () => {
    expect(
      terminalCloseLivenessFromInspection({
        hasChildProcesses: false,
        processEvidence: {
          foreground: { verdict: 'unverifiable' },
          children: { verdict: 'exited' }
        }
      })
    ).toBe('unverifiable')
  })
})
