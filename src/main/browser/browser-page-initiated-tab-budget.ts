/** Bounded so one hostile click cannot plant an unbounded number of tabs. */
export const MAX_PAGE_INITIATED_TABS_PER_WINDOW = 4
export const PAGE_INITIATED_TAB_WINDOW_MS = 2_000

export type PageInitiatedTabBudget = {
  /** Records the grant when it returns true; call only when the tab is actually being opened. */
  tryConsume: (now: number) => boolean
}

/**
 * Rate limit for tabs a page opens through `window.open` rather than a click Orca recognised.
 *
 * Chromium's popup blocker only requires *one* user activation, so a single click can run
 * `window.open` in a loop — and unlike the native popup windows this routing replaced, an Orca tab
 * persists into workspace session state and comes back on the next launch. A short rolling window
 * absorbs the loop (which fires within one tick) while leaving a person opening tab after tab
 * unaffected. Gesture-routed links need no budget: each one costs a real trusted click.
 */
export function createPageInitiatedTabBudget(
  maxPerWindow = MAX_PAGE_INITIATED_TABS_PER_WINDOW,
  windowMs = PAGE_INITIATED_TAB_WINDOW_MS
): PageInitiatedTabBudget {
  let grants: number[] = []
  return {
    tryConsume: (now) => {
      grants = grants.filter((grantedAt) => now - grantedAt < windowMs)
      if (grants.length >= maxPerWindow) {
        return false
      }
      grants.push(now)
      return true
    }
  }
}
