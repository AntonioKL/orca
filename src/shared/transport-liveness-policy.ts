/**
 * The one place that decides whether a transport peer is still there.
 *
 * Orca speaks over an ssh exec channel, a WebSocket, and a unix socket, and the framing of those
 * cannot merge. The *decision* can, and every copy of it that got written separately reintroduced
 * one of the two mistakes below. See #17823.
 */

export type TransportLivenessConfig = {
  /** How often the caller ticks, and therefore how often it may probe. */
  probeIntervalMs: number
  /** Inbound silence that justifies probing. Equal to probeIntervalMs to probe every idle tick. */
  probeAfterIdleMs: number
  /** Silence after a probe was armed that justifies declaring the link lost. */
  deadWindowMs: number
}

export type TransportLivenessInput = {
  now: number
  /** When this loop last ran. A gap far beyond the interval means *we* were paused. */
  lastTickAt: number
  /** When anything last arrived from the peer. Any inbound traffic counts, not just a reply. */
  lastInboundAt: number
  /** When the outstanding probe was armed, or null if none is. */
  probeOutstandingSince: number | null
}

export type TransportLivenessDecision = 'rebase-after-pause' | 'declare-lost' | 'probe' | 'wait'

/**
 * A tick gap beyond this means the process was suspended rather than the peer having died, so the
 * clocks must be rebased instead of judged.
 *
 * Why it is derived and not chosen: a healthy peer answers the PREVIOUS probe, so at any tick its
 * last inbound is already up to one probe interval old. A gap larger than
 * `deadWindowMs - probeIntervalMs` therefore pushes silence past the dead window on its own. A
 * threshold set at `deadWindowMs` — the intuitive choice, and the one three separate copies made —
 * leaves a dead band in which every healthy peer is declared lost after a host suspend, a VM
 * migration, or the local event loop stalling.
 */
export function transportLivenessPauseGapMs(config: TransportLivenessConfig): number {
  return config.deadWindowMs - config.probeIntervalMs
}

export function decideTransportLiveness(
  config: TransportLivenessConfig,
  input: TransportLivenessInput
): TransportLivenessDecision {
  const tickGapMs = input.now - input.lastTickAt
  // A backwards clock is a suspend/resume artifact too, not evidence about the peer.
  if (tickGapMs < 0 || tickGapMs >= transportLivenessPauseGapMs(config)) {
    return 'rebase-after-pause'
  }
  if (
    input.probeOutstandingSince !== null &&
    input.now - input.probeOutstandingSince >= config.deadWindowMs
  ) {
    return 'declare-lost'
  }
  if (
    input.probeOutstandingSince === null &&
    input.now - input.lastInboundAt >= config.probeAfterIdleMs
  ) {
    return 'probe'
  }
  return 'wait'
}

/**
 * Callers MUST arm `probeOutstandingSince` on a `'probe'` decision whether or not the probe
 * actually reached the wire.
 *
 * A probe that could not be sent is the strongest evidence available that the link is gone — it is
 * never a reason to stop watching. Gating the arming on a successful send (`if (send()) { armed =
 * now }`) disarms the only thing that can declare the link dead, so a saturated or half-open
 * transport is never judged at all. That is the exact defect fixed in #17817 on the SSH side, and
 * the shape this constant exists to stop anyone rebuilding.
 */
export const TRANSPORT_LIVENESS_ARM_PROBE_UNCONDITIONALLY = true
