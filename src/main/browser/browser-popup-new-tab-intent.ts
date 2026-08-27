/**
 * Whether a `window.open()` asks for a new tab rather than a popup window.
 *
 * Chromium already draws this line: an open with no window features is a tab
 * (`foreground-tab`/`background-tab`), and one that requests size or position
 * is a popup (`new-window`). Orca can only honour the tab answer by denying and
 * creating its own tab, which returns `null` to the page — so every shape whose
 * flow depends on the live handle stays a popup: named targets (the window is
 * addressed again later), featured windows (OAuth/SSO), and blank-URL opens
 * (the popup-blocker idiom that assigns `location` after an async step).
 */
export function isNewBrowserTabPopupIntent(details: {
  frameName: string
  disposition: string
  features: string
}): boolean {
  return (
    details.frameName === '' &&
    details.features.trim() === '' &&
    (details.disposition === 'foreground-tab' || details.disposition === 'background-tab')
  )
}
