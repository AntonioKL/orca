import {
  MOBILE_WEB_NAVIGATION_INTENTS,
  type MobileWebNavigationIntentTarget
} from './mobile-web-navigation-intent-buffer'
import { MOBILE_NATIVE_BASELINE_MODE } from './mobile-native-baseline-mode'

type MobileHomeRouter = {
  push(target: string): void
}

export function navigateFromMobileHome(args: {
  router: MobileHomeRouter
  hostId: string
  target: MobileWebNavigationIntentTarget
}): void {
  MOBILE_WEB_NAVIGATION_INTENTS.publishHostTarget(args.hostId, args.target)
  args.router.push(mobileHomeDestination(args.hostId, args.target, MOBILE_NATIVE_BASELINE_MODE))
}

export function mobileHostWorkspaceEntry(
  hostId: string,
  nativeBaselineEnabled = MOBILE_NATIVE_BASELINE_MODE
): `/hybrid?hostId=${string}` | `/h/${string}` {
  const encodedHostId = encodeURIComponent(hostId)
  return nativeBaselineEnabled ? `/h/${encodedHostId}` : `/hybrid?hostId=${encodedHostId}`
}

export function mobileHomeDestination(
  hostId: string,
  target: MobileWebNavigationIntentTarget,
  nativeBaselineEnabled: boolean
): string {
  if (!nativeBaselineEnabled) {
    return mobileHostWorkspaceEntry(hostId, false)
  }
  const hostRoute = mobileHostWorkspaceEntry(hostId, true)
  if (target.kind === 'session') {
    return `${hostRoute}/session/${encodeURIComponent(target.hostWorkspaceId)}`
  }
  if (target.kind === 'tasks') {
    return target.taskSource
      ? `${hostRoute}/tasks?taskSource=${encodeURIComponent(target.taskSource)}`
      : `${hostRoute}/tasks`
  }
  if (target.kind === 'accounts') {
    return `${hostRoute}/accounts`
  }
  if (target.kind === 'newWorkspace') {
    return `${hostRoute}?action=newWorktree`
  }
  if (target.kind === 'workspaceList' && target.notice) {
    return `${hostRoute}?notice=${encodeURIComponent(target.notice)}`
  }
  return hostRoute
}
