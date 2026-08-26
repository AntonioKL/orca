import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3-test',
    getAppMetrics: (): unknown[] => []
  }
}))

import { rendererCrashBreadcrumbOrigin } from '../../shared/crash-breadcrumb-origin'
import { clearCrashBreadcrumbsForTest, recordCrashBreadcrumb } from './crash-breadcrumb-store'
import { ProcessGoneDedupe } from './process-gone-dedupe'
import { recordProcessGoneCrash, type ProcessGoneCrashEvent } from './process-gone-recorder'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'

const CRASHED_WEB_CONTENTS_ID = 11
const SIBLING_WEB_CONTENTS_ID = 22
const CRASHED_ORIGIN = rendererCrashBreadcrumbOrigin(CRASHED_WEB_CONTENTS_ID)
const noMinidump = async () => null

function killedEvent(overrides: Partial<ProcessGoneCrashEvent> = {}): ProcessGoneCrashEvent {
  return {
    source: 'renderer',
    processType: 'renderer',
    reason: 'killed',
    exitCode: 1,
    expectedTeardown: 'none',
    details: { processType: 'renderer' },
    webContentsId: CRASHED_WEB_CONTENTS_ID,
    ...overrides
  }
}

function recordKilledRenderer(overrides: Partial<ProcessGoneCrashEvent> = {}): {
  details: Record<string, unknown>
} {
  const record = vi.fn().mockResolvedValue({ id: 'report-1' })
  recordProcessGoneCrash(
    { record, attachDetails: async () => null } as never,
    killedEvent(overrides),
    new ProcessGoneDedupe(),
    noMinidump
  )
  const input = record.mock.calls[0]?.[0] as { details?: Record<string, unknown> } | undefined
  return { details: input?.details ?? {} }
}

beforeEach(() => {
  const sink: TracerSink = { push: vi.fn(), flush: vi.fn(), close: vi.fn() }
  setActiveSink(sink)
  clearCrashBreadcrumbsForTest()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  _resetTracerForTests()
  clearCrashBreadcrumbsForTest()
})

describe('renderer silence on process-gone reports', () => {
  it('stamps how long the crashing renderer had been silent before a killed/1 death', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-08-20T11:01:20.000Z'))
    recordCrashBreadcrumb(
      'renderer_memory',
      { reason: 'interval', usedHeapMB: 120 },
      CRASHED_ORIGIN
    )
    vi.setSystemTime(Date.parse('2026-08-20T11:14:50.000Z'))

    expect(recordKilledRenderer().details).toMatchObject({
      rendererHeartbeatStatus: 'observed',
      rendererHeartbeatSilenceMs: 810_000,
      rendererHeartbeatMissedIntervals: 13
    })
  })

  it('does not credit the crashing renderer with a sibling renderer heartbeat', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-08-20T11:01:20.000Z'))
    recordCrashBreadcrumb('renderer_memory', { reason: 'interval' }, CRASHED_ORIGIN)
    vi.setSystemTime(Date.parse('2026-08-20T11:14:20.000Z'))
    recordCrashBreadcrumb(
      'renderer_memory',
      { reason: 'interval' },
      rendererCrashBreadcrumbOrigin(SIBLING_WEB_CONTENTS_ID)
    )
    vi.setSystemTime(Date.parse('2026-08-20T11:14:50.000Z'))

    expect(recordKilledRenderer().details).toMatchObject({
      rendererHeartbeatLastAt: '2026-08-20T11:01:20.000Z',
      rendererHeartbeatSilenceMs: 810_000
    })
  })

  it('does not read an OS sleep as a wedged renderer', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-08-20T03:00:20.000Z'))
    recordCrashBreadcrumb(
      'renderer_memory',
      { reason: 'interval', usedHeapMB: 120 },
      CRASHED_ORIGIN
    )
    vi.setSystemTime(Date.parse('2026-08-20T11:14:20.000Z'))
    recordCrashBreadcrumb('system_slept', { suspendedForMs: 29_580_000 })
    vi.setSystemTime(Date.parse('2026-08-20T11:14:50.000Z'))

    expect(recordKilledRenderer().details).toMatchObject({
      rendererHeartbeatSilenceMs: 29_670_000,
      rendererHeartbeatSuspendedMs: 29_580_000,
      rendererHeartbeatAwakeSilenceMs: 90_000,
      rendererHeartbeatMissedIntervals: 1
    })
  })

  it('records that no heartbeat was seen rather than omitting the field', () => {
    expect(recordKilledRenderer().details).toMatchObject({ rendererHeartbeatStatus: 'none' })
  })

  it('reports none when the only heartbeat in evidence names no emitting renderer', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-08-20T11:01:20.000Z'))
    recordCrashBreadcrumb('renderer_memory', { reason: 'interval' })
    vi.setSystemTime(Date.parse('2026-08-20T11:14:50.000Z'))

    const { details } = recordKilledRenderer()
    expect(details).toMatchObject({ rendererHeartbeatStatus: 'none' })
    expect(details).not.toHaveProperty('rendererHeartbeatSilenceMs')
  })

  it('does not stamp a renderer heartbeat figure on a child-process death', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-08-20T11:00:20.000Z'))
    recordCrashBreadcrumb(
      'renderer_memory',
      { reason: 'interval', usedHeapMB: 120 },
      CRASHED_ORIGIN
    )
    vi.setSystemTime(Date.parse('2026-08-20T11:14:50.000Z'))

    const { details } = recordKilledRenderer({
      source: 'child',
      processType: 'utility',
      reason: 'crashed',
      exitCode: 133,
      details: { processType: 'utility', serviceName: 'storage.mojom.StorageService' },
      webContentsId: undefined
    })
    expect(details).not.toHaveProperty('rendererHeartbeatStatus')
    expect(details).not.toHaveProperty('rendererHeartbeatSilenceMs')
    expect(details).not.toHaveProperty('rendererHeartbeatMissedIntervals')
  })

  it('measures against the same snapshot the report carries as evidence', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-08-20T11:01:20.000Z'))
    recordCrashBreadcrumb('renderer_memory', { reason: 'interval' }, CRASHED_ORIGIN)
    vi.setSystemTime(Date.parse('2026-08-20T11:14:50.000Z'))
    const record = vi.fn().mockResolvedValue({ id: 'report-1' })

    recordProcessGoneCrash(
      { record, attachDetails: async () => null } as never,
      killedEvent(),
      new ProcessGoneDedupe(),
      noMinidump
    )

    const input = record.mock.calls[0]?.[0] as {
      details: Record<string, unknown>
      breadcrumbs?: { name: string; createdAt: string }[]
    }
    const lastHeartbeat = input.breadcrumbs?.findLast(
      (breadcrumb) => breadcrumb.name === 'renderer_memory'
    )
    expect(input.details.rendererHeartbeatLastAt).toBe(lastHeartbeat?.createdAt)
  })
})
