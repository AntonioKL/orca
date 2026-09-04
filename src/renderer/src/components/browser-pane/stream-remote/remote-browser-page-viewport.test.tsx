// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'
import { REMOTE_BROWSER_STREAM_LIVE } from './remote-browser-stream-status'
import { RemoteBrowserPageViewport } from './remote-browser-page-viewport'

const browserTab: BrowserPage = {
  id: 'page-a',
  workspaceId: 'workspace-a',
  worktreeId: 'worktree-a',
  url: 'https://example.com',
  title: 'Example',
  loading: true,
  faviconUrl: null,
  canGoBack: false,
  canGoForward: false,
  loadError: null,
  createdAt: 1
}

function renderViewport({
  frameUrl = null,
  busy = true
}: { frameUrl?: string | null; busy?: boolean } = {}) {
  return render(
    <RemoteBrowserPageViewport
      remoteViewportRef={{ current: null }}
      imageRef={{ current: null }}
      frameUrl={frameUrl}
      frameMetadata={null}
      busy={busy}
      markup={{ isActive: false, baseImage: null } as never}
      browserTab={browserTab}
      remoteError={null}
      streamStatus={REMOTE_BROWSER_STREAM_LIVE}
      remoteCertificateTrustSupported={false}
      certificateFailure={null}
      remotePageHandle={null}
      activeRuntimeEnvironmentId="environment-a"
      worktreeId="worktree-a"
      runtimeWorktree="worktree-a"
      runtimeTarget={() => null}
      onReload={vi.fn()}
      onGoto={vi.fn()}
      onReconnect={vi.fn()}
      handleRemotePointerDown={vi.fn()}
      handleRemotePointerUp={vi.fn()}
      handleRemoteContextMenu={vi.fn()}
      handleRemoteScreenshotKeyDown={vi.fn()}
    />
  )
}

describe('RemoteBrowserPageViewport loading surface', () => {
  afterEach(cleanup)

  it('uses the themed viewport surface before the first frame', () => {
    const { container } = renderViewport()

    expect(container.firstElementChild?.classList.contains('bg-background')).toBe(true)
    expect(screen.queryByTestId('remote-browser-frame')).toBeNull()
    expect(screen.getByText('Opening remote browser')).toBeTruthy()
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })

  it('retains a decoded frame while the stream is busy without showing the opening state', () => {
    const { container } = renderViewport({ frameUrl: 'blob:decoded-frame', busy: true })

    expect(screen.getByTestId('remote-browser-frame').getAttribute('src')).toBe(
      'blob:decoded-frame'
    )
    expect(screen.queryByText('Opening remote browser')).toBeNull()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })
})
