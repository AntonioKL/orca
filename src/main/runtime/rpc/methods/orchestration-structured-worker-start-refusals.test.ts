import { describe, expect, it } from 'vitest'
import { assertStructuredWorkerStartSupported } from './orchestration-workers'

// Refusals rather than silent ignores. Each one names a start option `createStructuredWorkerSession`
// cannot honour; accepting any of them hands the coordinator a worker that differs from the receipt
// it is given back.
describe('structured worker-start refusals', () => {
  it('leaves every option alone when --structured was not asked for', () => {
    expect(() =>
      assertStructuredWorkerStartSupported({
        on: 'server-1',
        terminal: 'term_1',
        worktree: 'new-child',
        model: 'opus',
        effort: 'high'
      })
    ).not.toThrow()
  })

  it('accepts the combinations a structured worker can actually honour', () => {
    expect(() =>
      assertStructuredWorkerStartSupported({ structured: true, worktree: 'current' })
    ).not.toThrow()
    expect(() => assertStructuredWorkerStartSupported({ structured: true })).not.toThrow()
  })

  it.each([
    ['on', { on: 'server-1' }, /--on/],
    ['terminal', { terminal: 'term_1' }, /--terminal/],
    ['new-child', { worktree: 'new-child' }, /create the worktree first/],
    ['new-top-level', { worktree: 'new-top-level' }, /create the worktree first/],
    // Launch preferences reach the terminal path as `launch.preferences` and the structured path
    // not at all, while `launch.receipt.effective` echoes whatever was requested either way. Left
    // accepted, `--model opus` runs on the workspace default and the receipt still says `opus`.
    ['model', { model: 'opus' }, /--model and --effort/],
    ['effort', { model: 'opus', effort: 'high' }, /--model and --effort/]
  ])('refuses --structured with %s', (_name, params, message) => {
    expect(() => assertStructuredWorkerStartSupported({ structured: true, ...params })).toThrow(
      message
    )
  })
})
