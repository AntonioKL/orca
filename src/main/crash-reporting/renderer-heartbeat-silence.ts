import type { CrashReportBreadcrumb, CrashReportDetailValue } from '../../shared/crash-reporting'
import {
  RENDERER_MEMORY_HEARTBEAT_BREADCRUMB,
  RENDERER_MEMORY_HEARTBEAT_INTERVAL_MS
} from '../../shared/renderer-memory-heartbeat'
import { SYSTEM_SLEPT_BREADCRUMB } from '../system-sleep-breadcrumb'

// ─── Renderer silence before a process-gone death ───────────────────
// Why: the renderer samples its memory on a fixed interval, so the wall time
// between its last sample and the crash separates "a healthy app was force
// killed" from "the renderer had been wedged for 13 minutes" — the distinction
// the killed/1 cluster otherwise cannot make.
//
// What this does NOT claim:
// - Silence is not proof of a wedge. Chromium throttles background timers, so a
//   hidden or occluded window stretches the cadence on its own.
// - OS sleep stops renderer timers outright, so a recorded suspend span is
//   subtracted and reported separately. A sleep under the 60s reporting floor, a
//   dark wake that never fires resume, or a resume crumb already evicted from the
//   ring all leave their span in the awake figure.
// - Only a crumb carrying the dead renderer's own origin counts, so a second
//   window's heartbeat can never stand in for the one that died. No attributable
//   crumb reports `none` rather than a duration measured off someone else.

type CrashReportDetails = Record<string, CrashReportDetailValue>

type Heartbeat = { createdAt: string; atMs: number }

/** Newest sample the crashed renderer itself emitted; origin is proof, not inference. */
function lastHeartbeat(
  breadcrumbs: readonly CrashReportBreadcrumb[],
  reporterOrigin: string
): Heartbeat | null {
  let best: Heartbeat | null = null
  for (const breadcrumb of breadcrumbs) {
    if (
      breadcrumb.name !== RENDERER_MEMORY_HEARTBEAT_BREADCRUMB ||
      breadcrumb.origin !== reporterOrigin
    ) {
      continue
    }
    const atMs = Date.parse(breadcrumb.createdAt)
    if (Number.isFinite(atMs) && (!best || atMs > best.atMs)) {
      best = { createdAt: breadcrumb.createdAt, atMs }
    }
  }
  return best
}

/** Sleep is stamped at resume, so the crumb's own time is the wake edge of the span. */
function suspendedMsWithin(
  breadcrumbs: readonly CrashReportBreadcrumb[],
  fromMs: number,
  toMs: number
): number {
  let total = 0
  for (const breadcrumb of breadcrumbs) {
    if (breadcrumb.name !== SYSTEM_SLEPT_BREADCRUMB) {
      continue
    }
    const resumedAtMs = Date.parse(breadcrumb.createdAt)
    const suspendedForMs = breadcrumb.data?.suspendedForMs
    if (
      !Number.isFinite(resumedAtMs) ||
      typeof suspendedForMs !== 'number' ||
      !Number.isFinite(suspendedForMs) ||
      suspendedForMs <= 0
    ) {
      continue
    }
    total += Math.max(
      0,
      Math.min(toMs, resumedAtMs) - Math.max(fromMs, resumedAtMs - suspendedForMs)
    )
  }
  return total
}

/**
 * Reads the report's own breadcrumb snapshot, so ring eviction surfaces as
 * `none` instead of as a silently overstated duration.
 */
export function rendererHeartbeatSilenceDetails(
  breadcrumbs: readonly CrashReportBreadcrumb[],
  reporterOrigin: string,
  goneAtMs: number
): CrashReportDetails {
  const last = lastHeartbeat(breadcrumbs, reporterOrigin)
  if (!last) {
    // Explicit, so a reader can tell "no heartbeat in evidence" from a build
    // that never stamped the field.
    return { rendererHeartbeatStatus: 'none' }
  }
  const silenceMs = Math.max(0, goneAtMs - last.atMs)
  // Clamped: overlapping suspend crumbs must never explain more than the gap itself.
  const suspendedMs = Math.min(silenceMs, suspendedMsWithin(breadcrumbs, last.atMs, goneAtMs))
  const awakeSilenceMs = silenceMs - suspendedMs
  return {
    rendererHeartbeatStatus: 'observed',
    rendererHeartbeatLastAt: last.createdAt,
    rendererHeartbeatSilenceMs: silenceMs,
    ...(suspendedMs > 0
      ? {
          rendererHeartbeatSuspendedMs: suspendedMs,
          rendererHeartbeatAwakeSilenceMs: awakeSilenceMs
        }
      : {}),
    rendererHeartbeatIntervalMs: RENDERER_MEMORY_HEARTBEAT_INTERVAL_MS,
    // Why off the awake span: an overnight sleep is not a 479-interval wedge.
    rendererHeartbeatMissedIntervals: Math.floor(
      awakeSilenceMs / RENDERER_MEMORY_HEARTBEAT_INTERVAL_MS
    )
  }
}
