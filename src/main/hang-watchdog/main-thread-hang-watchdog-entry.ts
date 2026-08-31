import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { readFileSync, rmSync } from 'node:fs'
import { createHangWatchdogDetectionLoop } from './hang-watchdog-detection-loop'
import { writeHangDetectionMarker } from './hang-detection-marker'
import { subscribeSystemPowerLifecycle } from '../system-power-lifecycle'
import type {
  HangWatchdogWorkerData,
  MainToHangWatchdogWorkerMessage
} from './hang-watchdog-worker-protocol'

type HangWatchdogPort = {
  on: (event: 'message', listener: (message: MainToHangWatchdogWorkerMessage) => void) => unknown
  close: () => void
}

// Observation only: a false positive must never kill a live main thread mid-write.
export function recordHangObservation(options: {
  parentPid: number
  markerPath: string
  unresponsiveMs: number
  selfRecovered: boolean
  census?: Record<string, number>
}): void {
  if (!options.markerPath) {
    return
  }
  try {
    let detectedAtMs = Date.now()
    try {
      const prior = JSON.parse(readFileSync(options.markerPath, 'utf8')) as {
        detectedAtMs?: number
        detectedAt?: number
      }
      detectedAtMs = prior.detectedAtMs ?? prior.detectedAt ?? detectedAtMs
    } catch {
      // First observation in an episode.
    }
    writeHangDetectionMarker(options.markerPath, {
      // Preserve the original episode id when rewriting a self-recovered marker.
      detectedAt: detectedAtMs,
      detectedAtMs,
      parentPid: options.parentPid,
      unresponsiveMs: options.unresponsiveMs,
      selfRecovered: options.selfRecovered,
      census: options.census
    })
  } catch {
    // Why: telemetry is best-effort; a marker that cannot be written must not take down the watchdog.
  }
}

export function runWatchdog(
  config: HangWatchdogWorkerData,
  port: HangWatchdogPort | null = parentPort
): void {
  if (!port) {
    return
  }
  let lastCensus: Record<string, number> | undefined
  const loop = createHangWatchdogDetectionLoop({
    timeoutMs: config.timeoutMs,
    checkIntervalMs: config.checkIntervalMs,
    now: () => Date.now(),
    onHangDetected: (unresponsiveMs) =>
      recordHangObservation({
        parentPid: config.parentPid,
        markerPath: config.markerPath,
        unresponsiveMs,
        selfRecovered: false,
        census: lastCensus
      }),
    // Why: rewriting the marker keeps one observation per stall rather than two rows to reconcile.
    onHangResolved: (unresponsiveMs) =>
      recordHangObservation({
        parentPid: config.parentPid,
        markerPath: config.markerPath,
        unresponsiveMs,
        selfRecovered: true,
        census: lastCensus
      }),
    onHangSuspended: () => {
      // A suspend edge closes the episode without emitting a hang marker; any
      // marker already written belongs to the sleep false-positive.
      try {
        rmSync(config.markerPath, { force: true })
      } catch {
        // Best effort; the next launch can still consume the marker if removal races.
      }
    }
  })
  const unsubscribePower = subscribeSystemPowerLifecycle({
    onSuspend: () => loop.setSuspended(true),
    onResume: () => loop.setSuspended(false)
  })

  let checkTimer: ReturnType<typeof setInterval> | null = setInterval(
    () => loop.tick(),
    config.checkIntervalMs
  )
  port.on('message', (message: MainToHangWatchdogWorkerMessage) => {
    if (message.type === 'heartbeat') {
      lastCensus = message.census
      loop.recordHeartbeat()
    } else if (message.type === 'shutdown') {
      if (checkTimer) {
        clearInterval(checkTimer)
        checkTimer = null
      }
      port.close()
      unsubscribePower()
    }
  })
}

export function isHangWatchdogWorkerData(value: unknown): value is HangWatchdogWorkerData {
  const data = value as Partial<HangWatchdogWorkerData> | null
  return (
    !!data &&
    Number.isInteger(data.parentPid) &&
    (data.parentPid ?? 0) > 0 &&
    typeof data.markerPath === 'string' &&
    Number.isFinite(data.timeoutMs) &&
    (data.timeoutMs ?? 0) > 0 &&
    Number.isFinite(data.checkIntervalMs) &&
    (data.checkIntervalMs ?? 0) > 0
  )
}

if (!isMainThread && isHangWatchdogWorkerData(workerData)) {
  runWatchdog(workerData)
}
