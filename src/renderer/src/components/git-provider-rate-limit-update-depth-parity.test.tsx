// @vitest-environment happy-dom

/**
 * Provider parity: both rate-limit hooks must treat React #185 as a local render loop rather than a
 * provider outage. A GitHub-only guard would leave GitLab users reading a false rate-limit failure.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGitHubRateLimitSnapshot } from './github/github-rate-limit-display'
import { useGitLabRateLimitSnapshot } from './gitlab/gitlab-rate-limit-display'
import { clearReactErrorBoundaryReportingForTest } from '@/lib/react-error-boundary-reporting'
import { resetReactUpdateDepthEscalationForTest } from '@/lib/react-update-depth-escalation'

const REACT_185 =
  'Minified React error #185; visit https://react.dev/errors/185 for the full message.'

const mockStoreState = {
  settings: {},
  activeView: 'settings',
  activeModal: 'settings',
  activeTabType: null,
  rightSidebarTab: null,
  activeWorktreeId: null
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mockStoreState), {
    getState: () => mockStoreState
  })
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' }),
  callRuntimeRpc: vi.fn()
}))

const recordBreadcrumb = vi.fn()
const recordRendererError = vi.fn()
const ghRateLimit = vi.fn()
const glRateLimit = vi.fn()
const roots: Root[] = []

type RateLimitHook = { hasError: boolean; refresh: (force?: boolean) => Promise<void> }

function renderHook(useHook: () => RateLimitHook): { current: RateLimitHook | null } {
  const ref: { current: RateLimitHook | null } = { current: null }
  function Probe(): null {
    ref.current = useHook()
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<Probe />)
  })
  return ref
}

function breadcrumbSites(): string[] {
  return recordBreadcrumb.mock.calls
    .filter(([args]) => args?.name === 'react_update_depth_swallowed')
    .map(([args]) => String(args?.data?.site))
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  recordBreadcrumb.mockReset()
  recordRendererError.mockReset().mockResolvedValue({ ok: true, report: null, deduped: false })
  ghRateLimit.mockReset().mockRejectedValue(new Error(REACT_185))
  glRateLimit.mockReset().mockRejectedValue(new Error(REACT_185))
  resetReactUpdateDepthEscalationForTest()
  clearReactErrorBoundaryReportingForTest()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  Object.assign(globalThis.window, {
    api: {
      gh: { rateLimit: ghRateLimit },
      gl: { rateLimit: glRateLimit },
      crashReports: { recordBreadcrumb, recordRendererError }
    }
  })
})

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
  vi.restoreAllMocks()
})

describe.each([
  ['github', (): RateLimitHook => useGitHubRateLimitSnapshot({ autoRefresh: false })],
  ['gitlab', (): RateLimitHook => useGitLabRateLimitSnapshot({ autoRefresh: false })]
])('%s rate limit refresh', (provider, useHook) => {
  it('does not report a provider outage for a React #185', async () => {
    const hook = renderHook(useHook)

    await act(async () => {
      await hook.current?.refresh()
    })

    expect(hook.current?.hasError).toBe(false)
    expect(breadcrumbSites()).toEqual([`${provider}-rate-limit-display.refreshSnapshot`])
  })

  it('still reports an ordinary provider failure', async () => {
    ghRateLimit.mockRejectedValue(new Error('gh: HTTP 503'))
    glRateLimit.mockRejectedValue(new Error('glab: HTTP 503'))
    const hook = renderHook(useHook)

    await act(async () => {
      await hook.current?.refresh()
    })

    expect(hook.current?.hasError).toBe(true)
    expect(recordBreadcrumb).not.toHaveBeenCalled()
  })
})
