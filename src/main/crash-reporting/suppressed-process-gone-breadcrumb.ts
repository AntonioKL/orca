import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import { noteUnreportedProcessDeath } from './crashpad-capture'
import { recordCoalescedDurableCrashBreadcrumb } from './durable-crash-breadcrumb'
import type { ExpectedTeardownScope } from './process-gone-classification'

// Why: the coalesce map prunes every key against the calling window, so a shorter
// one here would weaken the other 30s coalescers. Stay uniform with them.
const SUPPRESSED_PROCESS_GONE_COALESCE_MS = 30_000

// Reasons where Crashpad can have written a dump for the dead process. A killed
// or never-launched process runs no handler, so fencing a dump against one would
// only cost a later crash its own signature.
const DUMP_PRODUCING_REASONS = new Set(['abnormal-exit', 'crashed', 'integrity-failure', 'oom'])

type SuppressedProcessGone = {
  source: 'renderer' | 'child'
  processType: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
  details: Record<string, unknown>
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function buildSuppressedProcessGoneBreadcrumbData({
  source,
  processType,
  reason,
  exitCode,
  expectedTeardown,
  details
}: {
  source: 'renderer' | 'child'
  processType: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
  details: Record<string, unknown>
}): CrashReportBreadcrumbData {
  const breadcrumb: CrashReportBreadcrumbData = {
    source,
    processType,
    reason,
    exitCode,
    expectedTeardown
  }
  const name = safeString(details.name)
  if (name) {
    breadcrumb.name = name
  }
  const serviceName = safeString(details.serviceName)
  if (serviceName) {
    breadcrumb.serviceName = serviceName
  }
  const type = safeString(details.type)
  if (type) {
    breadcrumb.type = type
  }
  return breadcrumb
}

// Why: key off the emitted breadcrumb, not the crash-report dedupe key, so two
// different recoverable services can never suppress each other's evidence.
function suppressedProcessGoneCoalesceKey(data: CrashReportBreadcrumbData): string {
  return JSON.stringify([
    data.source,
    data.processType,
    data.reason,
    data.exitCode,
    data.expectedTeardown,
    data.serviceName ?? null,
    data.name ?? null,
    data.type ?? null
  ])
}

/**
 * Records a process exit we deliberately do not report.
 *
 * Why coalesced: Chromium can crash-loop a recoverable child (network service seen
 * at 1459/min) and each suppressed event costs a span plus a forced disk flush,
 * which both floods the 30-entry ring and evicts the real pre-crash trail.
 */
export function recordSuppressedProcessGone(
  event: SuppressedProcessGone,
  {
    crashpadProcessType,
    goneAtMs,
    origin
  }: { crashpadProcessType: string | null; goneAtMs: number; origin?: string }
): void {
  // Nothing reports this exit, so nothing claims the dump Crashpad wrote for it;
  // fence it off before an unrelated report adopts its CHECK signature.
  if (DUMP_PRODUCING_REASONS.has(event.reason)) {
    noteUnreportedProcessDeath(crashpadProcessType, goneAtMs)
  }
  const data = buildSuppressedProcessGoneBreadcrumbData(event)
  const key = suppressedProcessGoneCoalesceKey(data)
  recordCoalescedDurableCrashBreadcrumb({
    name: 'process_gone_suppressed',
    data,
    coalesceKey: origin ? `${origin}\u0000${key}` : key,
    minIntervalMs: SUPPRESSED_PROCESS_GONE_COALESCE_MS,
    ...(origin ? { origin } : {})
  })
}
