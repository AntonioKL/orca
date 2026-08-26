// @vitest-environment happy-dom

/**
 * Field sighting: #185 rendered as red inline text under the build picker while the app crawled.
 * That text was `loadError`, not a boundary fallback — loadBuilds' catch swallowed the throw.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReleaseChannelSection } from './ReleaseChannelSection'
import { TooltipProvider } from '../ui/tooltip'
import { clearReactErrorBoundaryReportingForTest } from '@/lib/react-error-boundary-reporting'
import { resetReactUpdateDepthEscalationForTest } from '@/lib/react-update-depth-escalation'

const REACT_185 =
  'Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.'

const mockStoreState = {
  updateStatus: { state: 'idle' as const },
  releaseChannelOverride: null,
  setReleaseChannelOverride: vi.fn(),
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

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const recordBreadcrumb = vi.fn()
const recordRendererError = vi.fn()
const listBuilds = vi.fn()
const roots: Root[] = []

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  recordBreadcrumb.mockReset()
  recordRendererError.mockReset().mockResolvedValue({ ok: true, report: null, deduped: false })
  listBuilds.mockReset()
  resetReactUpdateDepthEscalationForTest()
  clearReactErrorBoundaryReportingForTest()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  Object.assign(globalThis.window, {
    api: {
      updater: {
        getVersion: vi.fn().mockResolvedValue('1.4.163'),
        listBuilds
      },
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

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <ReleaseChannelSection />
      </TooltipProvider>
    )
  })
  return container
}

describe('ReleaseChannelSection build load', () => {
  it('escalates a swallowed React #185 instead of painting it as a load error', async () => {
    listBuilds.mockRejectedValue(new Error(REACT_185))

    const container = await render()

    expect(container.textContent).not.toContain('Minified React error #185')
    expect(recordBreadcrumb.mock.calls[0]?.[0]).toMatchObject({
      name: 'react_update_depth_swallowed',
      data: { site: 'settings.ReleaseChannelSection.loadBuilds' }
    })
    // The one submittable artifact still carries React's own "boundary_id is a bystander" caveat.
    expect(recordRendererError.mock.calls[0]?.[0]?.attribution).toBe('unreliable')
  })

  it('still shows an ordinary load failure inline', async () => {
    listBuilds.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'))

    const container = await render()

    expect(container.textContent).toContain('getaddrinfo ENOTFOUND api.github.com')
    expect(recordBreadcrumb).not.toHaveBeenCalled()
    expect(recordRendererError).not.toHaveBeenCalled()
  })
})
