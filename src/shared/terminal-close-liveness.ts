/**
 * The only liveness states a destructive terminal close may consume.
 *
 * Unknown inspection is deliberately represented as `unverifiable`: losing
 * contact with the execution host is not evidence that its process exited.
 */
export type TerminalCloseLiveness = PtyLivenessVerdict['status']

export type TerminalCloseDecision = 'prompt' | 'close'

/** One policy table shared by tab, pane, and native-window close guards. */
export const TERMINAL_CLOSE_DECISION_BY_LIVENESS: Readonly<
  Record<TerminalCloseLiveness, TerminalCloseDecision>
> = Object.freeze({
  live: 'prompt',
  unverifiable: 'prompt',
  exited: 'close'
})

export type TerminalCloseInspection = {
  hasChildProcesses: boolean
  unavailable?: true
  /** Optional composite evidence published by newer paired hosts (#17444). */
  processEvidence?: {
    foreground?: { verdict: TerminalCloseLiveness }
    children?: { verdict: TerminalCloseLiveness }
  }
}

/** Normalize one inspection response before any close guard makes a decision. */
export function terminalCloseLivenessFromInspection(
  inspection: TerminalCloseInspection | null | undefined
): TerminalCloseLiveness {
  if (!inspection || inspection.unavailable === true) {
    return 'unverifiable'
  }
  const evidence = inspection.processEvidence
  if (evidence) {
    const verdicts = [evidence.foreground?.verdict, evidence.children?.verdict]
    if (verdicts.includes('unverifiable')) {
      return 'unverifiable'
    }
    if (verdicts.includes('live')) {
      return 'live'
    }
    if (verdicts.every((verdict) => verdict === 'exited')) {
      return 'exited'
    }
    return 'unverifiable'
  }
  return inspection.hasChildProcesses ? 'live' : 'exited'
}

/** Resolve the table entry every destructive close guard must use. */
export function terminalCloseDecision(liveness: TerminalCloseLiveness): TerminalCloseDecision {
  return TERMINAL_CLOSE_DECISION_BY_LIVENESS[liveness]
}
import type { PtyLivenessVerdict } from './pty-liveness-verdict'
