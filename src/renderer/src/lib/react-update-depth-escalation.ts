/**
 * A try/catch around an async setState is not an error boundary. When React's nested-update limit
 * trips (#185), the throw surfaces wherever the next setState happened to run — often inside an
 * awaited continuation whose catch was written for network or host failures. Those catches then
 * publish a failure verdict for a call that actually succeeded, and paint the React digest as
 * ordinary UI copy.
 *
 * This guard cannot stop the loop — React never learns about a throw raised outside its call stack.
 * What it does is keep the catch from lying: callers bail out instead of blaming their dependency,
 * and the swallowed throw leaves durable evidence naming the catch it landed in.
 */

import {
  isReactUpdateDepthError,
  REACT_UPDATE_DEPTH_SWALLOWED_BREADCRUMB
} from '../../../shared/react-update-depth-attribution'
import { recordRendererCrashBreadcrumb } from './crash-breadcrumb-recorder'
import { reportReactErrorBoundaryCrash } from './react-error-boundary-reporting'

// Matches the main process's own breadcrumb coalescing window, so a suppressed hit here is one the
// main side would have folded into the same ring entry anyway.
const SITE_ESCALATION_INTERVAL_MS = 30_000

// Marks the report as a swallowing catch rather than a mounted boundary; boundaryId caps at 120 chars.
const ASYNC_CATCH_BOUNDARY_ID = 'async-catch:react-update-depth'

const lastEscalationAtBySiteId = new Map<string, number>()
// A runaway can reach dozens of catches, and the report ring holds five reports total: one more
// report per site would evict the native-crash and boundary evidence needed to diagnose it. The
// per-site detail rides the breadcrumb trail instead, which the eventual report carries.
let reportedSwallowedUpdateDepth = false

/**
 * Returns true when `error` is React's nested-update-limit throw, after logging it and recording a
 * per-site crash breadcrumb. Callers should then bail out of their catch rather than apply their
 * normal failure handling: the call they awaited succeeded, so their error state would be a verdict
 * about a dependency that never failed, and the extra setState would feed the same loop.
 *
 * Returns false — and does nothing — for every other error, so expected failures keep their path.
 *
 * `siteId` names the catch, e.g. `settings.ReleaseChannelSection.loadBuilds`.
 */
export function escalateReactUpdateDepthError(error: unknown, siteId: string): boolean {
  if (!isReactUpdateDepthError(error)) {
    return false
  }
  try {
    if (!claimSiteEscalation(siteId)) {
      return true
    }
    // Why unconditional: the web client stubs crash reporting to a no-op, so without this the guard
    // would trade a mislabeled digest for total silence. Throttled with the breadcrumb.
    console.error(
      `[react-update-depth] React #185 (nested update limit) surfaced in the catch at ${siteId}; that site is a bystander, not the cause:`,
      error
    )
    recordRendererCrashBreadcrumb(REACT_UPDATE_DEPTH_SWALLOWED_BREADCRUMB, {
      site: siteId,
      message: error instanceof Error ? error.message : String(error)
    })
    reportSwallowedUpdateDepthOnce(error)
  } catch (escalationError) {
    // A guard that throws would replace the loop with a second, less informative failure.
    console.warn('[react-update-depth] Failed to escalate a swallowed #185:', escalationError)
  }
  return true
}

/**
 * Returns true when this site may escalate now, and records the claim. The loop re-enters the same
 * catch thousands of times a second; expiring the claim keeps a later, unrelated runaway audible.
 */
function claimSiteEscalation(siteId: string): boolean {
  const now = Date.now()
  const escalatedAt = lastEscalationAtBySiteId.get(siteId)
  // A backwards clock jump reads as negative; escalate rather than stay silent until it catches up.
  if (escalatedAt !== undefined) {
    const elapsed = now - escalatedAt
    if (elapsed >= 0 && elapsed < SITE_ESCALATION_INTERVAL_MS) {
      return false
    }
  }
  for (const [expiredSiteId, expiredAt] of lastEscalationAtBySiteId) {
    if (now - expiredAt >= SITE_ESCALATION_INTERVAL_MS) {
      lastEscalationAtBySiteId.delete(expiredSiteId)
    }
  }
  lastEscalationAtBySiteId.set(siteId, now)
  return true
}

/**
 * One submittable artifact per session, claimed synchronously so concurrent catches cannot race past
 * it. A constant boundaryId keeps the report honest — the boundary_id of a swallowed #185 is a
 * bystander either way, and the breadcrumbs the report carries name every catch the loop reached.
 */
function reportSwallowedUpdateDepthOnce(error: unknown): void {
  if (reportedSwallowedUpdateDepth) {
    return
  }
  reportedSwallowedUpdateDepth = true
  void reportReactErrorBoundaryCrash({
    boundaryId: ASYNC_CATCH_BOUNDARY_ID,
    // No boundary caught this, so no boundary surface describes it; the breadcrumbs carry the sites.
    surface: 'app-root',
    error
  }).catch((reportError) => {
    console.warn('[react-update-depth] Failed to record a swallowed #185:', reportError)
  })
}

export function resetReactUpdateDepthEscalationForTest(): void {
  lastEscalationAtBySiteId.clear()
  reportedSwallowedUpdateDepth = false
}
