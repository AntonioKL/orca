import { describe, expect, it } from 'vitest'

import {
  describeRelayPtyJobControlSupport,
  readRelayPtyJobControlSupport,
  relayPtyJobControlProbeJs,
  RELAY_PTY_JOB_CONTROL_MARKER
} from './relay-pty-job-control-capability'

describe('relay pty job-control capability', () => {
  it('reads a present verdict', () => {
    expect(
      readRelayPtyJobControlSupport(`ORCA-NPTY-PROBE-OK\n${RELAY_PTY_JOB_CONTROL_MARKER}present\n`)
    ).toBe('present')
  })

  it('reads an absent verdict', () => {
    expect(
      readRelayPtyJobControlSupport(`${RELAY_PTY_JOB_CONTROL_MARKER}absent\r\nORCA-NPTY-PROBE-OK\n`)
    ).toBe('absent')
  })

  it('reads a probe that could not look as unknown, not absent', () => {
    expect(
      readRelayPtyJobControlSupport(`ORCA-NPTY-PROBE-OK\n${RELAY_PTY_JOB_CONTROL_MARKER}unknown\n`)
    ).toBe('unknown')
  })

  it('reads output with no marker at all as unknown, not absent', () => {
    // An older relay, a probe that never ran, or stdout the host truncated.
    expect(readRelayPtyJobControlSupport('ORCA-NPTY-PROBE-OK\n')).toBe('unknown')
    expect(readRelayPtyJobControlSupport('')).toBe('unknown')
  })

  it('reads an unrecognised verdict as unknown, not absent', () => {
    expect(readRelayPtyJobControlSupport(`${RELAY_PTY_JOB_CONTROL_MARKER}maybe`)).toBe('unknown')
  })

  it('probes all three job symbols and falls back to unknown when the look throws', () => {
    const js = relayPtyJobControlProbeJs('"conpty"')
    expect(js).toContain('assignCurrentProcessToJob')
    expect(js).toContain('terminateJob')
    expect(js).toContain('listJobProcessIds')
    expect(js).toContain('catch{jc="unknown"}')
  })

  it('never calls an unanswered probe an absence in the operator line', () => {
    expect(describeRelayPtyJobControlSupport('unknown')).toContain('not a confirmed absence')
    expect(describeRelayPtyJobControlSupport('unknown')).not.toContain(': absent')
    expect(describeRelayPtyJobControlSupport('absent')).toContain('absent')
    expect(describeRelayPtyJobControlSupport('present')).toContain('present')
  })
})
