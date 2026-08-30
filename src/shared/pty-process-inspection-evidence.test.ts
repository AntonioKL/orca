import { describe, expect, it } from 'vitest'
import { combinePtyProcessInspectionVerdict } from './pty-process-inspection-evidence'

describe('PTY inspection evidence combination', () => {
  it('lets any unverifiable component poison the combined verdict', () => {
    expect(
      combinePtyProcessInspectionVerdict({
        foreground: { verdict: 'unverifiable', reason: 'exit raced the foreground read' },
        children: { verdict: 'exited' }
      })
    ).toBe('unverifiable')
  })

  it.each([
    [
      'both exited',
      {
        foreground: { verdict: 'exited' as const, processName: null },
        children: { verdict: 'exited' as const }
      },
      'exited'
    ],
    [
      'foreground live',
      {
        foreground: { verdict: 'live' as const, processName: 'codex' },
        children: { verdict: 'exited' as const }
      },
      'live'
    ],
    [
      'child live',
      {
        foreground: { verdict: 'exited' as const, processName: null },
        children: { verdict: 'live' as const }
      },
      'live'
    ]
  ])('combines %s', (_label, evidence, expected) => {
    expect(combinePtyProcessInspectionVerdict(evidence)).toBe(expected)
  })
})
