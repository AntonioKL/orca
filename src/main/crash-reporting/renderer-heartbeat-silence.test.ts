import { describe, expect, it } from 'vitest'
import type { CrashReportBreadcrumb } from '../../shared/crash-reporting'
import { rendererHeartbeatSilenceDetails } from './renderer-heartbeat-silence'

const CRASHED_ORIGIN = 'renderer:11'
const OTHER_ORIGIN = 'renderer:22'
const GONE_AT = Date.parse('2026-08-20T11:14:50.000Z')

function heartbeat(createdAt: string, origin?: string): CrashReportBreadcrumb {
  return {
    createdAt,
    name: 'renderer_memory',
    data: { reason: 'interval', usedHeapMB: 120 },
    ...(origin ? { origin } : {})
  }
}

/** Stamped at resume, so `createdAt` is the wake instant and the span runs backwards from it. */
function slept(resumedAt: string, suspendedForMs: unknown): CrashReportBreadcrumb {
  return {
    createdAt: resumedAt,
    name: 'system_slept',
    data: { suspendedForMs } as CrashReportBreadcrumb['data']
  }
}

describe('rendererHeartbeatSilenceDetails', () => {
  it('measures how long the crashing renderer had been silent before it died', () => {
    const breadcrumbs = [
      heartbeat('2026-08-20T11:00:20.000Z', CRASHED_ORIGIN),
      heartbeat('2026-08-20T11:01:20.000Z', CRASHED_ORIGIN)
    ]

    expect(rendererHeartbeatSilenceDetails(breadcrumbs, CRASHED_ORIGIN, GONE_AT)).toEqual({
      rendererHeartbeatStatus: 'observed',
      rendererHeartbeatLastAt: '2026-08-20T11:01:20.000Z',
      rendererHeartbeatSilenceMs: 810_000,
      rendererHeartbeatIntervalMs: 60_000,
      rendererHeartbeatMissedIntervals: 13
    })
  })

  it('reports no missed intervals for a renderer that was beating up to the crash', () => {
    const breadcrumbs = [heartbeat('2026-08-20T11:14:20.000Z', CRASHED_ORIGIN)]

    expect(rendererHeartbeatSilenceDetails(breadcrumbs, CRASHED_ORIGIN, GONE_AT)).toMatchObject({
      rendererHeartbeatSilenceMs: 30_000,
      rendererHeartbeatMissedIntervals: 0
    })
  })

  it('never measures off another window heartbeat', () => {
    const breadcrumbs = [
      heartbeat('2026-08-20T11:01:20.000Z', CRASHED_ORIGIN),
      heartbeat('2026-08-20T11:14:20.000Z', OTHER_ORIGIN)
    ]

    expect(rendererHeartbeatSilenceDetails(breadcrumbs, CRASHED_ORIGIN, GONE_AT)).toMatchObject({
      rendererHeartbeatLastAt: '2026-08-20T11:01:20.000Z',
      rendererHeartbeatSilenceMs: 810_000
    })
  })

  it('reports none when the newest heartbeat names no emitting renderer', () => {
    expect(
      rendererHeartbeatSilenceDetails(
        [heartbeat('2026-08-20T11:01:20.000Z')],
        CRASHED_ORIGIN,
        GONE_AT
      )
    ).toEqual({ rendererHeartbeatStatus: 'none' })
  })

  it('records the absence explicitly instead of omitting the field', () => {
    expect(
      rendererHeartbeatSilenceDetails(
        [{ createdAt: '2026-08-20T11:01:20.000Z', name: 'app_started', origin: CRASHED_ORIGIN }],
        CRASHED_ORIGIN,
        GONE_AT
      )
    ).toEqual({ rendererHeartbeatStatus: 'none' })
  })

  it('ignores the one-shot highwater profile, which is not on the sampling cadence', () => {
    const breadcrumbs: CrashReportBreadcrumb[] = [
      heartbeat('2026-08-20T11:01:20.000Z', CRASHED_ORIGIN),
      {
        createdAt: '2026-08-20T11:14:40.000Z',
        name: 'renderer_memory_highwater',
        data: { thresholdPct: 80 },
        origin: CRASHED_ORIGIN
      }
    ]

    expect(rendererHeartbeatSilenceDetails(breadcrumbs, CRASHED_ORIGIN, GONE_AT)).toMatchObject({
      rendererHeartbeatLastAt: '2026-08-20T11:01:20.000Z'
    })
  })

  it('clamps a backwards clock correction instead of reporting negative silence', () => {
    const breadcrumbs = [heartbeat('2026-08-20T11:20:00.000Z', CRASHED_ORIGIN)]

    expect(rendererHeartbeatSilenceDetails(breadcrumbs, CRASHED_ORIGIN, GONE_AT)).toMatchObject({
      rendererHeartbeatSilenceMs: 0,
      rendererHeartbeatMissedIntervals: 0
    })
  })

  it('skips a breadcrumb whose timestamp cannot be parsed', () => {
    const breadcrumbs = [
      heartbeat('2026-08-20T11:01:20.000Z', CRASHED_ORIGIN),
      heartbeat('not-a-timestamp', CRASHED_ORIGIN)
    ]

    expect(rendererHeartbeatSilenceDetails(breadcrumbs, CRASHED_ORIGIN, GONE_AT)).toMatchObject({
      rendererHeartbeatLastAt: '2026-08-20T11:01:20.000Z'
    })
  })

  it('discounts an OS sleep span instead of calling it a renderer wedge', () => {
    const breadcrumbs = [
      heartbeat('2026-08-20T03:00:20.000Z', CRASHED_ORIGIN),
      slept('2026-08-20T11:14:20.000Z', 29_580_000)
    ]

    expect(rendererHeartbeatSilenceDetails(breadcrumbs, CRASHED_ORIGIN, GONE_AT)).toEqual({
      rendererHeartbeatStatus: 'observed',
      rendererHeartbeatLastAt: '2026-08-20T03:00:20.000Z',
      rendererHeartbeatSilenceMs: 29_670_000,
      rendererHeartbeatSuspendedMs: 29_580_000,
      rendererHeartbeatAwakeSilenceMs: 90_000,
      rendererHeartbeatIntervalMs: 60_000,
      rendererHeartbeatMissedIntervals: 1
    })
  })

  it('counts only the part of a sleep that overlaps the silence window', () => {
    const breadcrumbs = [
      heartbeat('2026-08-20T11:04:50.000Z', CRASHED_ORIGIN),
      // Slept 11:00:50 -> 11:10:50, so only the 6m after the heartbeat is explained.
      slept('2026-08-20T11:10:50.000Z', 600_000)
    ]

    expect(rendererHeartbeatSilenceDetails(breadcrumbs, CRASHED_ORIGIN, GONE_AT)).toMatchObject({
      rendererHeartbeatSilenceMs: 600_000,
      rendererHeartbeatSuspendedMs: 360_000,
      rendererHeartbeatAwakeSilenceMs: 240_000,
      rendererHeartbeatMissedIntervals: 4
    })
  })

  it('leaves silence undiscounted when the sleep ended before the last heartbeat', () => {
    const breadcrumbs = [
      slept('2026-08-20T11:00:20.000Z', 600_000),
      heartbeat('2026-08-20T11:01:20.000Z', CRASHED_ORIGIN)
    ]

    expect(rendererHeartbeatSilenceDetails(breadcrumbs, CRASHED_ORIGIN, GONE_AT)).toEqual({
      rendererHeartbeatStatus: 'observed',
      rendererHeartbeatLastAt: '2026-08-20T11:01:20.000Z',
      rendererHeartbeatSilenceMs: 810_000,
      rendererHeartbeatIntervalMs: 60_000,
      rendererHeartbeatMissedIntervals: 13
    })
  })

  it('sums repeated sleeps inside one silence window', () => {
    const breadcrumbs = [
      heartbeat('2026-08-20T11:01:20.000Z', CRASHED_ORIGIN),
      slept('2026-08-20T11:05:20.000Z', 120_000),
      slept('2026-08-20T11:12:20.000Z', 180_000)
    ]

    expect(rendererHeartbeatSilenceDetails(breadcrumbs, CRASHED_ORIGIN, GONE_AT)).toMatchObject({
      rendererHeartbeatSilenceMs: 810_000,
      rendererHeartbeatSuspendedMs: 300_000,
      rendererHeartbeatAwakeSilenceMs: 510_000,
      rendererHeartbeatMissedIntervals: 8
    })
  })

  it('ignores a sleep crumb whose span is not a usable number', () => {
    const breadcrumbs = [
      heartbeat('2026-08-20T11:01:20.000Z', CRASHED_ORIGIN),
      slept('2026-08-20T11:12:20.000Z', 'a while')
    ]

    expect(rendererHeartbeatSilenceDetails(breadcrumbs, CRASHED_ORIGIN, GONE_AT)).toMatchObject({
      rendererHeartbeatSilenceMs: 810_000,
      rendererHeartbeatMissedIntervals: 13
    })
  })
})
