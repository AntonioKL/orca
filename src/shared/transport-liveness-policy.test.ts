import { describe, expect, it } from 'vitest'
import {
  decideTransportLiveness,
  transportLivenessPauseGapMs,
  type TransportLivenessConfig
} from './transport-liveness-policy'

// The SSH mux's shape: probe every tick, judge on total inbound silence.
const SSH_LIKE: TransportLivenessConfig = {
  probeIntervalMs: 5_000,
  probeAfterIdleMs: 5_000,
  deadWindowMs: 20_000
}

// The WebSocket shape: probe only after a longer idle, then a separate grace.
const SOCKET_LIKE: TransportLivenessConfig = {
  probeIntervalMs: 10_000,
  probeAfterIdleMs: 25_000,
  deadWindowMs: 25_000
}

describe('transport liveness policy', () => {
  it('probes an idle peer and declares it lost only after the dead window', () => {
    expect(
      decideTransportLiveness(SSH_LIKE, {
        now: 5_000,
        lastTickAt: 0,
        lastInboundAt: 0,
        probeOutstandingSince: null
      })
    ).toBe('probe')

    expect(
      decideTransportLiveness(SSH_LIKE, {
        now: 10_000,
        lastTickAt: 5_000,
        lastInboundAt: 0,
        probeOutstandingSince: 5_000
      })
    ).toBe('wait')

    expect(
      decideTransportLiveness(SSH_LIKE, {
        now: 25_000,
        lastTickAt: 21_000,
        lastInboundAt: 0,
        probeOutstandingSince: 5_000
      })
    ).toBe('declare-lost')
  })

  it('never declares a peer lost on the tick that a pause pushed past the window', () => {
    // The dead band every hand-written copy reintroduced. A healthy peer answers the PREVIOUS
    // probe, so it is already ~one interval stale; a tick gap of 16s makes it look 21s silent,
    // past the 20s window, while a rebase armed at 20s would not have fired.
    expect(
      decideTransportLiveness(SSH_LIKE, {
        now: 21_000,
        lastTickAt: 5_000,
        lastInboundAt: 0,
        probeOutstandingSince: 1_000
      })
    ).toBe('rebase-after-pause')
  })

  it('derives the pause gap below the window rather than at it', () => {
    // The invariant: any tick gap that can push silence past deadWindowMs must rebase first.
    for (const config of [SSH_LIKE, SOCKET_LIKE]) {
      const pauseGap = transportLivenessPauseGapMs(config)
      expect(pauseGap).toBeLessThan(config.deadWindowMs)
      expect(pauseGap + config.probeIntervalMs).toBeLessThanOrEqual(config.deadWindowMs)
    }
  })

  it('treats a backwards clock as a pause, not as evidence about the peer', () => {
    expect(
      decideTransportLiveness(SSH_LIKE, {
        now: 1_000,
        lastTickAt: 9_000,
        lastInboundAt: 0,
        probeOutstandingSince: 0
      })
    ).toBe('rebase-after-pause')
  })

  it('waits rather than probing a peer that is still within its idle allowance', () => {
    expect(
      decideTransportLiveness(SOCKET_LIKE, {
        now: 10_000,
        lastTickAt: 0,
        lastInboundAt: 0,
        probeOutstandingSince: null
      })
    ).toBe('wait')
  })

  it('keeps a peer alive on any inbound traffic, not just a probe reply', () => {
    // lastInboundAt moving is enough; the caller clears probeOutstandingSince on any frame.
    expect(
      decideTransportLiveness(SSH_LIKE, {
        now: 30_000,
        lastTickAt: 26_000,
        lastInboundAt: 29_000,
        probeOutstandingSince: null
      })
    ).toBe('wait')
  })
})
