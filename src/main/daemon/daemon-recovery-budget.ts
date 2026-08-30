/**
 * How long a transient wedge takes to drain — the Windows update-relaunch AV/disk-pressure shape
 * #8697 sized the grace against. The grace exists to adopt that daemon *with* its live sessions
 * instead of killing them, so the recovery budget has to outlast this.
 */
export const TRANSIENT_WEDGE_DRAIN_MS = 20_000

/**
 * What one connect (+ listSessions) attempt may spend. Deliberately more generous than the 3s
 * daemon health check: this probe is the second opinion on that check's verdict, and a machine
 * loaded enough to time the check out on a live daemon would time out a probe held to the same
 * bar too — turning "could not verify" into "dead". Left to its own defaults the client instead
 * grants a fresh 5s to each of four connect/hello steps plus 30s to the request, so one probe of
 * a wedged daemon could outlast the entire recovery.
 */
export const DAEMON_RECOVERY_PROBE_MS = 8_000

/**
 * One absolute wall-clock budget for adopting-or-replacing whatever daemon already owns the
 * endpoint at startup. Every caller of the out-of-process launcher shares it — the desktop
 * startup gate, orcad, and user-initiated restart — because a wedged endpoint costs the same
 * wherever it is met.
 *
 * Both bounds matter and daemon-init-wedged-daemon-grace.test.ts pins them. Above
 * TRANSIENT_WEDGE_DRAIN_MS, with room for the probe in flight when the daemon finally answers to
 * finish its hello + listSessions rather than expire on the deadline. Below what the startup PTY
 * gate can still absorb, since the kill, fork and lease that follow run inside the same fail-open
 * cap: grace used to be a probe count with no clock at all, so it ran past that cap and the
 * sessions were lost anyway, after the user watched the app hang (STA-5732).
 */
export const DAEMON_RECOVERY_BUDGET_MS = 24_000

/** One attempt's share of the recovery budget, never reaching past the deadline. */
export function daemonRecoveryProbeTimeoutMs(recoveryDeadlineMs: number): number {
  return Math.max(1, Math.min(DAEMON_RECOVERY_PROBE_MS, recoveryDeadlineMs - Date.now()))
}
