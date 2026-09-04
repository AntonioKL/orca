import { describe, expect, it } from 'vitest'
import {
  NO_SESSION_TABS_LOAD_FAILURE,
  SESSION_TABS_LOAD_FAILURE_ATTEMPTS,
  nextSessionTabsLoadFailure,
  sessionTabsLoadSurface
} from './session-tabs-load-surface'

function failedTimes(count: number) {
  let failure = NO_SESSION_TABS_LOAD_FAILURE
  for (let attempt = 0; attempt < count; attempt += 1) {
    failure = nextSessionTabsLoadFailure(failure, 'host_error')
  }
  return failure
}

describe('session tabs load surface', () => {
  it('keeps the spinner while the first attempts are still in flight', () => {
    expect(
      sessionTabsLoadSurface({
        connected: true,
        terminalsLoaded: false,
        visibleTabCount: 0,
        failure: failedTimes(SESSION_TABS_LOAD_FAILURE_ATTEMPTS - 1)
      })
    ).toBe('loading')
  })

  it('replaces the spinner once loading has failed repeatedly', () => {
    expect(
      sessionTabsLoadSurface({
        connected: true,
        terminalsLoaded: false,
        visibleTabCount: 0,
        failure: failedTimes(SESSION_TABS_LOAD_FAILURE_ATTEMPTS)
      })
    ).toBe('error')
  })

  it('never covers a session that already has tabs or a landed snapshot', () => {
    const failure = failedTimes(SESSION_TABS_LOAD_FAILURE_ATTEMPTS + 3)
    expect(
      sessionTabsLoadSurface({
        connected: true,
        terminalsLoaded: true,
        visibleTabCount: 0,
        failure
      })
    ).toBe('ready')
    expect(
      sessionTabsLoadSurface({
        connected: true,
        terminalsLoaded: false,
        visibleTabCount: 2,
        failure
      })
    ).toBe('ready')
    expect(
      sessionTabsLoadSurface({
        connected: false,
        terminalsLoaded: false,
        visibleTabCount: 0,
        failure
      })
    ).toBe('ready')
  })

  it('clears the failure run on the next success', () => {
    const cleared = nextSessionTabsLoadFailure(failedTimes(5), null)
    expect(cleared).toEqual(NO_SESSION_TABS_LOAD_FAILURE)
    expect(
      sessionTabsLoadSurface({
        connected: true,
        terminalsLoaded: false,
        visibleTabCount: 0,
        failure: cleared
      })
    ).toBe('loading')
  })

  it('reports the most recent failure code', () => {
    expect(nextSessionTabsLoadFailure(failedTimes(2), 'too_large')).toEqual({
      attempts: 3,
      code: 'too_large'
    })
  })
})
