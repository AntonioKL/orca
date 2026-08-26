// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REACT_UPDATE_DEPTH_SWALLOWED_BREADCRUMB } from '../../../shared/react-update-depth-attribution'
import { clearReactErrorBoundaryReportingForTest } from './react-error-boundary-reporting'
import {
  escalateReactUpdateDepthError,
  resetReactUpdateDepthEscalationForTest
} from './react-update-depth-escalation'

const REACT_185 =
  'Minified React error #185; visit https://react.dev/errors/185 for the full message.'

const recordBreadcrumb = vi.fn()
const recordRendererError = vi.fn()

vi.mock('@/store', () => {
  const state = {
    activeView: 'settings',
    activeModal: null,
    activeTabType: null,
    rightSidebarTab: null,
    activeWorktreeId: null
  }
  return { useAppStore: { getState: () => state } }
})

function breadcrumbSites(): string[] {
  return recordBreadcrumb.mock.calls
    .filter(([args]) => args?.name === REACT_UPDATE_DEPTH_SWALLOWED_BREADCRUMB)
    .map(([args]) => String(args?.data?.site))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-25T00:00:00Z'))
  recordBreadcrumb.mockReset()
  recordRendererError.mockReset().mockResolvedValue({ ok: true, report: null, deduped: false })
  resetReactUpdateDepthEscalationForTest()
  clearReactErrorBoundaryReportingForTest()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  Object.assign(globalThis.window, {
    api: { crashReports: { recordBreadcrumb, recordRendererError } }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('escalateReactUpdateDepthError', () => {
  it('leaves ordinary failures on their own path', () => {
    expect(escalateReactUpdateDepthError(new Error('ssh: connect timeout'), 'site.a')).toBe(false)
    expect(recordBreadcrumb).not.toHaveBeenCalled()
    expect(recordRendererError).not.toHaveBeenCalled()
  })

  it('claims a #185 and names the catching site in a breadcrumb', () => {
    expect(escalateReactUpdateDepthError(new Error(REACT_185), 'site.a')).toBe(true)
    expect(breadcrumbSites()).toEqual(['site.a'])
  })

  it('recognises the unminified development message too', () => {
    expect(
      escalateReactUpdateDepthError(new Error('Maximum update depth exceeded.'), 'site.a')
    ).toBe(true)
    expect(breadcrumbSites()).toEqual(['site.a'])
  })

  it('throttles a hot catch but keeps every distinct site audible', () => {
    for (let i = 0; i < 500; i += 1) {
      escalateReactUpdateDepthError(new Error(REACT_185), 'site.a')
    }
    escalateReactUpdateDepthError(new Error(REACT_185), 'site.b')

    expect(breadcrumbSites()).toEqual(['site.a', 'site.b'])
  })

  it('lets a later runaway at the same catch speak again', () => {
    escalateReactUpdateDepthError(new Error(REACT_185), 'site.a')
    vi.advanceTimersByTime(30_000)
    escalateReactUpdateDepthError(new Error(REACT_185), 'site.a')

    expect(breadcrumbSites()).toEqual(['site.a', 'site.a'])
  })

  it('escalates through a backwards clock jump rather than going silent', () => {
    escalateReactUpdateDepthError(new Error(REACT_185), 'site.a')
    vi.setSystemTime(new Date('2026-08-24T23:00:00Z'))
    escalateReactUpdateDepthError(new Error(REACT_185), 'site.a')

    expect(breadcrumbSites()).toHaveLength(2)
  })

  // The report ring holds five reports; a report per site would evict the evidence it documents.
  it('writes at most one crash report per session across every site', async () => {
    escalateReactUpdateDepthError(new Error(REACT_185), 'site.a')
    escalateReactUpdateDepthError(new Error(REACT_185), 'site.b')
    vi.advanceTimersByTime(10 * 60_000)
    escalateReactUpdateDepthError(new Error(REACT_185), 'site.a')
    await vi.runAllTimersAsync()

    expect(recordRendererError).toHaveBeenCalledTimes(1)
    expect(recordRendererError.mock.calls[0]?.[0]?.attribution).toBe('unreliable')
    expect(breadcrumbSites().length).toBeGreaterThan(1)
  })

  it('still claims the error when crash reporting is unavailable', () => {
    Object.assign(globalThis.window, { api: undefined })

    expect(escalateReactUpdateDepthError(new Error(REACT_185), 'site.a')).toBe(true)
  })
})
