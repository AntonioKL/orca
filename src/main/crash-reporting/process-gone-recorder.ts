import os from 'node:os'
import { app } from 'electron'
import {
  isCrashReportReason,
  sanitizeCrashReportString,
  type CrashReportBreadcrumbData
} from '../../shared/crash-reporting'
import { decodePosixWaitStatus, describePosixWaitStatus } from '../../shared/posix-wait-status'
import { rendererCrashBreadcrumbOrigin } from '../../shared/crash-breadcrumb-origin'
import type { CrashReportStore } from './crash-report-store'
import { getCrashBreadcrumbSnapshot } from './crash-breadcrumb-store'
import {
  recordCoalescedDurableCrashBreadcrumb,
  recordDurableCrashBreadcrumb
} from './durable-crash-breadcrumb'
import {
  correlateChildProcessDeath,
  trackRendererSiblingAttribution
} from './process-gone-sibling-attribution'
import {
  shouldRecordProcessGoneCrash,
  type ExpectedTeardownScope,
  type ProcessGoneSource
} from './process-gone-classification'
import { buildProcessGoneCrashDetails } from './process-gone-diagnostics'
import { rendererHeartbeatSilenceDetails } from './renderer-heartbeat-silence'
import { buildSuppressedProcessGoneBreadcrumbData } from './suppressed-process-gone-breadcrumb'
import {
  getProcessGoneDedupeKey,
  processGoneDedupe,
  type ProcessGoneDedupe
} from './process-gone-dedupe'
import {
  findSiblingChildDeaths,
  siblingProcessDeathDetails
} from './process-gone-sibling-correlation'
import { getMainProcessLifecycleIdentity } from './main-process-lifecycle-identity'
import { scheduleCrashpadDumpPrune } from './crashpad-capture'
import {
  attachMinidumpSignature,
  captureProcessMinidump,
  expectedCrashpadProcessType,
  type MinidumpCapture
} from './process-gone-minidump-attachment'
import { flushActiveSink, startSpan } from '../observability/tracer'

export type ProcessGoneCrashEvent = {
  source: ProcessGoneSource
  processType: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
  details: Record<string, unknown>
  webContentsId?: number
}

type CrashReportRecorderStore = Pick<CrashReportStore, 'record' | 'attachDetails'>

// Why: the coalesce map prunes every key against the calling window, so a shorter
// one here would weaken the other 30s coalescers. Stay uniform with them.
const SUPPRESSED_PROCESS_GONE_COALESCE_MS = 30_000

function processGoneBreadcrumbData(event: ProcessGoneCrashEvent) {
  return buildSuppressedProcessGoneBreadcrumbData(event)
}

function processGoneRendererOrigin(event: ProcessGoneCrashEvent): string | undefined {
  return event.webContentsId === undefined
    ? undefined
    : rendererCrashBreadcrumbOrigin(event.webContentsId)
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

// Why: POSIX exit codes arrive as raw wait statuses (61696 = exit 241); name the
// meaning on the span so bundles read without manual decoding. Display-only —
// the recorded exitCode stays raw. launch-failed codes are not wait statuses.
function decodedExitCodeAttribute(event: ProcessGoneCrashEvent): Record<string, string> {
  if (process.platform === 'win32' || event.reason === 'launch-failed' || event.exitCode === null) {
    return {}
  }
  const decoded = decodePosixWaitStatus(event.exitCode)
  return decoded ? { 'crash.exit_code_decoded': describePosixWaitStatus(decoded) } : {}
}

function persistFailureData(event: ProcessGoneCrashEvent, error: unknown) {
  const errorCode =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  return {
    ...processGoneBreadcrumbData(event),
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: sanitizeCrashReportString(error instanceof Error ? error.message : String(error)),
    ...(errorCode ? { errorCode } : {})
  }
}

export function recordProcessGoneCrash(
  store: CrashReportRecorderStore | null,
  event: ProcessGoneCrashEvent,
  dedupe: ProcessGoneDedupe = processGoneDedupe,
  capture: MinidumpCapture = captureProcessMinidump
): void {
  if (!isCrashReportReason(event.reason)) {
    return
  }
  const goneAt = Date.now()
  const serviceName =
    typeof event.details.serviceName === 'string' ? event.details.serviceName : undefined
  if (event.source === 'child') {
    correlateChildProcessDeath({
      at: goneAt,
      processType: event.processType,
      ...(serviceName ? { serviceName } : {}),
      reason: event.reason,
      exitCode: event.exitCode
    })
  }
  // Crashpad captures suppressed service crashes too; keep a crash loop from
  // filling the disk even when no user-facing report is created.
  scheduleCrashpadDumpPrune()
  if (
    !shouldRecordProcessGoneCrash({
      source: event.source,
      processType: event.processType,
      serviceName,
      reason: event.reason,
      exitCode: event.exitCode,
      expectedTeardown: event.expectedTeardown
    })
  ) {
    // Why: Chromium can crash-loop a recoverable child (network service seen at
    // 1459/min) and each suppressed event costs a span plus a forced disk flush,
    // which both floods the 30-entry ring and evicts the real pre-crash trail.
    const suppressedData = processGoneBreadcrumbData(event)
    const origin = processGoneRendererOrigin(event)
    recordCoalescedDurableCrashBreadcrumb({
      name: 'process_gone_suppressed',
      data: suppressedData,
      coalesceKey: origin
        ? `${origin}\u0000${suppressedProcessGoneCoalesceKey(suppressedData)}`
        : suppressedProcessGoneCoalesceKey(suppressedData),
      minIntervalMs: SUPPRESSED_PROCESS_GONE_COALESCE_MS,
      ...(origin ? { origin } : {})
    })
    return
  }
  if (!store) {
    recordDurableCrashBreadcrumb(
      'crash_report_store_unavailable',
      processGoneBreadcrumbData(event),
      'Crash report store unavailable',
      processGoneRendererOrigin(event)
    )
    return
  }

  const key = getProcessGoneDedupeKey(
    event.source,
    event.processType,
    event.reason,
    event.exitCode,
    event.webContentsId
  )
  const claim = dedupe.tryClaim(key)
  if (!claim) {
    return
  }
  const mainProcessLifecycle = getMainProcessLifecycleIdentity()
  const siblingDeaths =
    event.source === 'renderer'
      ? findSiblingChildDeaths({ reason: event.reason, exitCode: event.exitCode, at: goneAt })
      : []
  const siblingDetails =
    siblingDeaths.length > 0 ? siblingProcessDeathDetails(siblingDeaths, goneAt) : {}
  const reporterOrigin = processGoneRendererOrigin(event)
  const breadcrumbs = getCrashBreadcrumbSnapshot(reporterOrigin)
  const reportBreadcrumbs = breadcrumbs?.map(({ origin: _origin, ...breadcrumb }) => breadcrumb)
  const crashDetails = buildProcessGoneCrashDetails(
    {
      ...event.details,
      ...mainProcessLifecycle,
      ...siblingDetails,
      // Why gated: only a renderer emits the heartbeat, and only its own origin
      // attributes one — a utility/zygote/network-service death has no renderer
      // to measure, so stamping a figure there would describe a process it never
      // observed.
      ...(event.source === 'renderer' && reporterOrigin
        ? rendererHeartbeatSilenceDetails(breadcrumbs, reporterOrigin, goneAt)
        : {})
    },
    event.processType
  )
  const span = startSpan('electron.process_gone', {
    attributes: {
      'crash.source': event.source,
      'crash.process_type': event.processType,
      'crash.reason': event.reason,
      ...(event.exitCode !== null ? { 'crash.exit_code': event.exitCode } : {}),
      ...decodedExitCodeAttribute(event),
      'app.version': app.getVersion(),
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      'app.main_process.pid': mainProcessLifecycle.mainProcessPid,
      'app.main_process.launch_id': mainProcessLifecycle.mainProcessLaunchId,
      'app.main_process.started_at': mainProcessLifecycle.mainProcessStartedAt,
      details: crashDetails,
      breadcrumbs: reportBreadcrumbs
    }
  })
  // Why: a renderer crash can be followed by another process exit before the
  // trace batch window closes, so make the primary signal durable immediately.
  span.fail(
    `${event.source} process gone: ${event.processType} ${event.reason} (${event.exitCode ?? 'unknown'})`
  )
  flushActiveSink()

  const crashedAtMs = Date.now()
  const expectedProcessType = expectedCrashpadProcessType(event.source, event.processType)
  const recorded = store.record({
    source: event.source,
    processType: event.processType,
    reason: event.reason,
    exitCode: event.exitCode,
    appVersion: app.getVersion(),
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    details: crashDetails,
    breadcrumbs: reportBreadcrumbs
  })
  trackRendererSiblingAttribution(
    event,
    goneAt,
    siblingDeaths,
    (reportId, details) => store.attachDetails(reportId, details),
    recorded,
    processGoneBreadcrumbData(event),
    reporterOrigin
  )
  void recorded
    .then((report) => {
      // Why: kept off the returned chain so a minidump failure can never reach
      // the persist-failure handler below and release a claim that did persist.
      void attachMinidumpSignature(
        store,
        report.id,
        crashedAtMs,
        expectedProcessType,
        capture
      ).catch((error) => {
        console.error('[crash-reporting] Failed to attach minidump signature:', error)
        recordDurableCrashBreadcrumb(
          'minidump_signature_attach_failed',
          processGoneBreadcrumbData(event),
          error instanceof Error ? error.message : String(error),
          reporterOrigin
        )
      })
    })
    .catch((error) => {
      dedupe.release(claim)
      console.error('[crash-reporting] Failed to persist crash report:', error)
      const data = persistFailureData(event, error)
      recordDurableCrashBreadcrumb(
        'crash_report_persist_failed',
        data,
        `${String(data.errorName)}: ${String(data.errorMessage)}`,
        reporterOrigin
      )
    })
}
