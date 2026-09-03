// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage } from '../../../../shared/browser-workspace-types'

const mocks = vi.hoisted(() => ({ attach: vi.fn(), detach: vi.fn() }))

vi.mock('./browser-client-page-renderer-installation', () => ({
  attachBrowserClientPageToViewport: mocks.attach
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), message: vi.fn() }
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { installClientHostedPaneApi } from './client-hosted-browser-pane-test-rig'
import { ClientHostedBrowserPagePane } from './ClientHostedBrowserPagePane'

const PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  pageHostGeneration: 7
}

/** Verbatim from Electron 43.4.1: main destroyed the guest, the tag still holds its id. */
function invalidGuestInstanceId(): Error {
  return new Error('Invalid guestInstanceId: 7')
}

/** Verbatim from Electron 43.4.1: focus() after the retained tag left the DOM. */
function nullContentWindowFocus(): TypeError {
  return new TypeError("Cannot read properties of null (reading 'focus')")
}

function page(): BrowserPage {
  return {
    id: 'page-a',
    workspaceId: 'workspace-a',
    worktreeId: 'worktree-a',
    url: 'https://example.internal/',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function createGuest(): Electron.WebviewTag & { getURL: ReturnType<typeof vi.fn> } {
  const webview = document.createElement('webview') as Electron.WebviewTag & {
    getURL: ReturnType<typeof vi.fn>
  }
  Object.assign(webview, {
    getURL: vi.fn(() => 'https://example.internal/'),
    getTitle: vi.fn(() => 'Example'),
    isLoading: vi.fn(() => false),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    focus: vi.fn(),
    blur: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    loadURL: vi.fn(async () => {})
  })
  mocks.attach.mockReturnValue({
    webview,
    detach: mocks.detach,
    nextMetadataRevision: vi.fn(() => 1)
  })
  return webview
}

function paneElement(isActive: boolean): React.JSX.Element {
  return (
    <TooltipProvider>
      <ClientHostedBrowserPagePane
        browserTab={page()}
        workspaceId="workspace-a"
        chromeShortcutScope="focused"
        runtimeEnvironmentId="environment-a"
        worktreeId="worktree-a"
        placement={PLACEMENT}
        isActive={isActive}
        onUpdatePageState={vi.fn()}
        onSetUrl={vi.fn()}
      />
    </TooltipProvider>
  )
}

let webview: ReturnType<typeof createGuest>

beforeEach(() => {
  mocks.attach.mockReset()
  mocks.detach.mockReset()
  installClientHostedPaneApi()
  webview = createGuest()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('client-hosted browser pane over a dead guest', () => {
  it('degrades to the unavailable notice when the guest was destroyed in main', () => {
    webview.getURL.mockImplementation(() => {
      throw invalidGuestInstanceId()
    })

    expect(() => render(paneElement(true))).not.toThrow()
    expect(screen.getByText('Client-hosted browser unavailable')).toBeTruthy()
    expect(mocks.detach).toHaveBeenCalled()
  })

  it('survives activation focus after the retained tag left the DOM', () => {
    const view = render(paneElement(false))
    webview.focus = vi.fn(() => {
      throw nullContentWindowFocus()
    })

    expect(() =>
      act(() => {
        view.rerender(paneElement(true))
      })
    ).not.toThrow()
    expect(webview.focus).toHaveBeenCalled()
  })
})
