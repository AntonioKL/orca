import { afterEach, describe, expect, it } from 'vitest'
import {
  cliRuntimeScopeKey,
  createCliUnresponsiveError,
  getCliUnresponsiveBlockedUntilMs,
  recordCliDeadlineKill,
  recordCliResponded,
  _resetCliUnresponsiveBreaker
} from './hosted-cli-unresponsive-breaker'

const NOW = 1_700_000_000_000
const GH = cliRuntimeScopeKey('gh')

afterEach(() => {
  _resetCliUnresponsiveBreaker()
})

describe('hosted CLI unresponsive breaker', () => {
  it('lets a single deadline kill through — one slow call is not a wedged binary', () => {
    recordCliDeadlineKill(GH, NOW)

    expect(getCliUnresponsiveBlockedUntilMs(GH, NOW)).toBeNull()
  })

  it('blocks after two consecutive deadline kills and reopens when the backoff expires', () => {
    recordCliDeadlineKill(GH, NOW)
    recordCliDeadlineKill(GH, NOW)

    expect(getCliUnresponsiveBlockedUntilMs(GH, NOW)).toBe(NOW + 60_000)
    expect(getCliUnresponsiveBlockedUntilMs(GH, NOW + 59_999)).toBe(NOW + 60_000)
    expect(getCliUnresponsiveBlockedUntilMs(GH, NOW + 60_000)).toBeNull()
  })

  it('escalates the backoff when the re-probe after a block wedges again', () => {
    recordCliDeadlineKill(GH, NOW)
    recordCliDeadlineKill(GH, NOW)
    recordCliDeadlineKill(GH, NOW + 60_000)

    // Why escalating: #18234's wrapper recursion is a configuration fault, so
    // re-probing every minute forever pays a full deadline of CPU each time.
    expect(getCliUnresponsiveBlockedUntilMs(GH, NOW + 60_000)).toBe(NOW + 60_000 + 300_000)
  })

  it('clamps the backoff at the longest rung', () => {
    for (let i = 0; i < 20; i++) {
      recordCliDeadlineKill(GH, NOW)
    }

    expect(getCliUnresponsiveBlockedUntilMs(GH, NOW)).toBe(NOW + 1_800_000)
  })

  it('closes the breaker as soon as gh answers anything', () => {
    recordCliDeadlineKill(GH, NOW)
    recordCliDeadlineKill(GH, NOW)
    expect(getCliUnresponsiveBlockedUntilMs(GH, NOW)).not.toBeNull()

    recordCliResponded(GH)

    expect(getCliUnresponsiveBlockedUntilMs(GH, NOW)).toBeNull()
  })

  it('resets the escalation too, so a later wedge starts at the shortest backoff', () => {
    recordCliDeadlineKill(GH, NOW)
    recordCliDeadlineKill(GH, NOW)
    recordCliDeadlineKill(GH, NOW)
    recordCliResponded(GH)

    recordCliDeadlineKill(GH, NOW)
    recordCliDeadlineKill(GH, NOW)

    expect(getCliUnresponsiveBlockedUntilMs(GH, NOW)).toBe(NOW + 60_000)
  })

  it('scopes by runtime so a wedged native gh does not block a WSL distro', () => {
    recordCliDeadlineKill(GH, NOW)
    recordCliDeadlineKill(GH, NOW)

    expect(getCliUnresponsiveBlockedUntilMs(GH, NOW)).not.toBeNull()
    expect(getCliUnresponsiveBlockedUntilMs(cliRuntimeScopeKey('gh', 'Ubuntu'), NOW)).toBeNull()
  })

  it('scopes by CLI so a wedged gh does not disable GitLab', () => {
    recordCliDeadlineKill(GH, NOW)
    recordCliDeadlineKill(GH, NOW)

    expect(getCliUnresponsiveBlockedUntilMs(cliRuntimeScopeKey('glab'), NOW)).toBeNull()
  })

  it('keys WSL distros case-insensitively, the way the runner resolves them', () => {
    expect(cliRuntimeScopeKey('gh', 'Ubuntu')).toBe(cliRuntimeScopeKey('gh', 'ubuntu'))
    expect(cliRuntimeScopeKey('gh', undefined)).toBe(GH)
  })

  it('names the deadline kills and the wrapper hypothesis in the blocked error', () => {
    const error = createCliUnresponsiveError('gh', NOW + 60_000, NOW)

    expect(error.cliUnresponsiveBlocked).toBe(true)
    expect(error.message).toContain('~60s')
    expect(error.message).toContain('18234')
    // Why stderr: callers classify gh failures from stderr, not from message.
    expect(error.stderr).toBe(error.message)
  })

  it('evicts cold runtimes instead of growing without bound', () => {
    for (let i = 0; i < 200; i++) {
      recordCliDeadlineKill(cliRuntimeScopeKey('gh', `distro-${i}`), NOW)
      recordCliDeadlineKill(cliRuntimeScopeKey('gh', `distro-${i}`), NOW)
    }

    expect(getCliUnresponsiveBlockedUntilMs(cliRuntimeScopeKey('gh', 'distro-0'), NOW)).toBeNull()
    expect(
      getCliUnresponsiveBlockedUntilMs(cliRuntimeScopeKey('gh', 'distro-199'), NOW)
    ).not.toBeNull()
  })
})
