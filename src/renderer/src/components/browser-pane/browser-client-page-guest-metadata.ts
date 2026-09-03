import { redactKagiSessionToken } from '../../../../shared/browser-url'
import type { BrowserClientPageMetadataSnapshot } from './browser-client-page-metadata-publisher'

/**
 * What a client-hosted guest currently is, read straight off the webview, or null once the tag
 * can no longer reach its guest.
 *
 * `eventUrl` wins when a navigation event carries one: the tag's own getURL() can still report the
 * previous page while the event is being delivered. `loading` is forced for did-start-loading,
 * which fires before isLoading() flips.
 *
 * Why total rather than throwing: a guest destroyed in main leaves the tag holding its id, so
 * every method on it throws `Invalid guestInstanceId` from then on — and every caller reads from
 * a React effect, where that unwinds the whole workbench error boundary.
 */
export function readBrowserClientPageGuestMetadataIfLive(
  webview: Electron.WebviewTag,
  eventUrl?: string,
  loading?: boolean
): BrowserClientPageMetadataSnapshot | null {
  try {
    const url = redactKagiSessionToken(eventUrl || webview.getURL() || 'about:blank')
    return {
      url,
      title: webview.getTitle() || url || 'Browser',
      loading: loading ?? webview.isLoading(),
      canGoBack: webview.canGoBack(),
      canGoForward: webview.canGoForward()
    }
  } catch {
    return null
  }
}
