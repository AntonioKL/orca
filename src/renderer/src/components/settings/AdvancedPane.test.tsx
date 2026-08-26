import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { AdvancedPane } from './AdvancedPane'
import { getAdvancedPaneSearchEntries, getAdvancedSearchEntry } from './advanced-search'

const rendererAppPlatform = vi.hoisted(() => vi.fn((): NodeJS.Platform => 'win32'))
const webClientLocation = vi.hoisted(() => vi.fn(() => false))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: rendererAppPlatform }))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: webClientLocation }))

function renderAdvancedPane(): string {
  return renderToStaticMarkup(
    <AdvancedPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
  )
}

describe('AdvancedPane', () => {
  beforeEach(() => {
    rendererAppPlatform.mockReturnValue('win32')
    webClientLocation.mockReturnValue(false)
  })

  it('renders HTTP/1.1 compatibility as a neutral advanced setting', () => {
    const markup = renderAdvancedPane()

    expect(markup).toContain('Compatibility')
    expect(markup).toContain('HTTP/1.1 Compatibility')
    expect(markup).toContain('aria-checked="false"')
    expect(markup).toContain('Explain HTTP/1.1 compatibility')
    expect(getAdvancedSearchEntry().http1Compatibility.keywords).toContain('support')
    expect(getAdvancedSearchEntry().http1Compatibility.keywords).toContain('troubleshooting')
  })

  it('offers Safe Graphics Mode on the Windows desktop app', () => {
    expect(renderAdvancedPane()).toContain('Safe Graphics Mode')
    expect(
      getAdvancedPaneSearchEntries({ isWindows: true, isWebClient: false }).map(
        (entry) => entry.title
      )
    ).toContain('Safe Graphics Mode')
  })

  // Why: the fallback is win32 desktop-only, so elsewhere the row would describe recovery
  // behavior that never happens — and search must not point at a control that cannot exist.
  it('hides Safe Graphics Mode where the fallback can never engage', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      rendererAppPlatform.mockReturnValue(platform)
      expect(renderAdvancedPane()).not.toContain('Safe Graphics Mode')
    }
    rendererAppPlatform.mockReturnValue('win32')
    webClientLocation.mockReturnValue(true)
    expect(renderAdvancedPane()).not.toContain('Safe Graphics Mode')
    // Why both: a Windows web client is the case the search catalog used to answer for while
    // the pane rendered nothing, so it has to be asserted alongside the non-Windows one.
    for (const platform of [
      { isWindows: false, isWebClient: false },
      { isWindows: true, isWebClient: true }
    ]) {
      expect(getAdvancedPaneSearchEntries(platform).map((entry) => entry.title)).not.toContain(
        'Safe Graphics Mode'
      )
    }
  })
})
