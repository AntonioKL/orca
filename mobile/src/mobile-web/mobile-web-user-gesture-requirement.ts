import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebNavigationAuthority } from './mobile-web-navigation-operations'

export function mobileWebUserGestureConsumer(
  navigationAuthority: MobileWebNavigationAuthority | undefined
): () => boolean {
  return () => navigationAuthority?.consumeRecentUserGesture() ?? false
}

// A missing consumer denies: an operation reachable without the shell's gesture plumbing has no
// gesture to spend.
export function requireRecentUserGesture(
  consumeRecentUserGesture: (() => boolean) | undefined
): void {
  if (!consumeRecentUserGesture?.()) {
    throw new MobileWebBrokerError('permission_required')
  }
}
