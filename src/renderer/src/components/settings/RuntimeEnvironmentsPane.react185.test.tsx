// @vitest-environment happy-dom

/**
 * The probe's catch publishes `status: null` into the global store the sidebar host picker reads.
 * React #185 is a local render loop, so routing it down that path marks a server that answered
 * fine as unverifiable — the SSH-boundary rule that loss of contact is never evidence of death.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeEnvironmentsPane } from './RuntimeEnvironmentsPane'
import { TooltipProvider } from '../ui/tooltip'
import { clearReactErrorBoundaryReportingForTest } from '@/lib/react-error-boundary-reporting'
import { resetReactUpdateDepthEscalationForTest } from '@/lib/react-update-depth-escalation'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { RUNTIME_PROTOCOL_VERSION } from '../../../../shared/protocol-version'

const REACT_185 =
  'Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.'

const setRuntimeEnvironments = vi.fn()
const setRuntimeEnvironmentStatus = vi.fn()

const mockStoreState = {
  remoteServerUpdates: new Map(),
  remoteServerUpdatesChecking: false,
  remoteServerUpdatesRunning: false,
  refreshRemoteServerUpdates: vi.fn(),
  setRemoteServerUpdateDialogOpen: vi.fn(),
  setRuntimeEnvironments,
  setRuntimeEnvironmentStatus,
  settingsSearchQuery: '',
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

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }))

const recordBreadcrumb = vi.fn()
const recordRendererError = vi.fn()
const list = vi.fn()
const getStatus = vi.fn()
const roots: Root[] = []

const ENVIRONMENT = {
  id: 'env-1',
  name: 'build-box',
  source: 'pairing',
  createdAt: 0,
  lastSeenAt: 0,
  preferredEndpointId: 'ep-1',
  endpoints: [{ id: 'ep-1', kind: 'direct', url: 'https://build-box.example' }]
}

const RUNTIME_STATUS = {
  ok: true,
  version: '1.4.163',
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleMobileVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleRuntimeClientVersion: RUNTIME_PROTOCOL_VERSION,
  capabilities: []
}

const SETTINGS = { activeRuntimeEnvironmentId: null } as unknown as GlobalSettings

function swallowedSites(): string[] {
  return recordBreadcrumb.mock.calls
    .filter(([args]) => args?.name === 'react_update_depth_swallowed')
    .map(([args]) => String(args?.data?.site))
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  recordBreadcrumb.mockReset()
  recordRendererError.mockReset().mockResolvedValue({ ok: true, report: null, deduped: false })
  list.mockReset().mockResolvedValue([ENVIRONMENT])
  getStatus.mockReset().mockResolvedValue({ ok: true, result: RUNTIME_STATUS })
  toastError.mockReset()
  setRuntimeEnvironments.mockReset()
  setRuntimeEnvironmentStatus.mockReset()
  resetReactUpdateDepthEscalationForTest()
  clearReactErrorBoundaryReportingForTest()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  Object.assign(globalThis.window, {
    api: {
      runtimeEnvironments: { list, getStatus },
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
        <RuntimeEnvironmentsPane
          settings={SETTINGS}
          setActiveRuntimeEnvironmentPreference={vi.fn().mockResolvedValue(true)}
        />
      </TooltipProvider>
    )
  })
  await act(async () => {
    await Promise.resolve()
  })
  return container
}

describe('RuntimeEnvironmentsPane host probe', () => {
  it('keeps the answered verdict when the loop throws after the probe replied', async () => {
    setRuntimeEnvironmentStatus.mockImplementation(() => {
      throw new Error(REACT_185)
    })

    const container = await render()

    expect(swallowedSites()).toEqual(['settings.RuntimeEnvironmentsPane.probeEnvironmentStatus'])
    expect(container.textContent).not.toContain('Minified React error #185')
    // The probe itself answered before the loop threw, so its verdict survives.
    const row = container.querySelector('[data-settings-section="env-1"]')
    expect(row?.textContent).toContain('Compatible')
  })

  it('publishes no host verdict when the loop throws before the probe replied', async () => {
    getStatus.mockImplementation(async () => {
      throw new Error(REACT_185)
    })

    const container = await render()

    expect(swallowedSites()).toEqual(['settings.RuntimeEnvironmentsPane.probeEnvironmentStatus'])
    // Nothing was observed about the host, so the sidebar registry gains no verdict at all.
    expect(setRuntimeEnvironmentStatus).not.toHaveBeenCalled()
    const row = container.querySelector('[data-settings-section="env-1"]')
    expect(row?.textContent).not.toContain('Status unavailable')
    expect(container.textContent).not.toContain('Minified React error #185')
  })

  it('does not toast the React digest as a failed environment list', async () => {
    setRuntimeEnvironments.mockImplementation(() => {
      throw new Error(REACT_185)
    })

    await render()

    expect(swallowedSites()).toEqual(['settings.RuntimeEnvironmentsPane.loadEnvironments'])
    expect(toastError).not.toHaveBeenCalled()
  })

  it('leaves an ordinary probe failure on its host-blaming error path', async () => {
    getStatus.mockRejectedValue(new Error('connect ETIMEDOUT 10.0.0.4:443'))

    const container = await render()

    expect(recordBreadcrumb).not.toHaveBeenCalled()
    expect(setRuntimeEnvironmentStatus).toHaveBeenCalledWith(
      'env-1',
      expect.objectContaining({ status: null })
    )
    expect(container.textContent).toContain('connect ETIMEDOUT 10.0.0.4:443')
  })
})
