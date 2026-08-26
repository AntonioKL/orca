import { describe, expect, it } from 'vitest'
import {
  terminalCreateFailureMessage,
  unpairedWebClientWorkspaceOutcome,
  unroutableWorkspaceOutcome
} from './terminal-create-routing-outcome'

// Why: the SSH execution boundary forbids reporting loss of contact as a definite outcome.
const DEFINITE_FAILURE_RE = /could not open a new terminal/i

describe('terminalCreateFailureMessage', () => {
  it('stays silent for created and no-active-workspace', () => {
    expect(terminalCreateFailureMessage({ status: 'created' })).toBeNull()
    expect(terminalCreateFailureMessage({ status: 'no-active-workspace' })).toBeNull()
  })

  it('does not claim a definite failure when the create was never confirmed', () => {
    const message = terminalCreateFailureMessage({
      status: 'unverifiable',
      message: 'The paired runtime did not confirm whether the terminal was created.'
    })

    expect(message).not.toBeNull()
    expect(message).not.toMatch(DEFINITE_FAILURE_RE)
    expect(message).toContain(
      'The paired runtime did not confirm whether the terminal was created.'
    )
  })

  it('states a definite failure only when the host refused the create', () => {
    expect(
      terminalCreateFailureMessage({
        status: 'failed',
        message: 'worktree is required'
      })
    ).toMatch(DEFINITE_FAILURE_RE)
    expect(terminalCreateFailureMessage(unroutableWorkspaceOutcome({ kind: 'missing' }))).toMatch(
      DEFINITE_FAILURE_RE
    )
    expect(terminalCreateFailureMessage(unpairedWebClientWorkspaceOutcome())).toMatch(
      DEFINITE_FAILURE_RE
    )
  })
})
