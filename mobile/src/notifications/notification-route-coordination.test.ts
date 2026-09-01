import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  getNotificationNavigationTarget,
  notificationCredentialRecoveryRoute
} from './notification-routing'

const rootLayoutSource = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8')

describe('notification route coordination', () => {
  it('keeps host-only and workspace notification intents distinct', () => {
    expect(getNotificationNavigationTarget({ hostId: 'host-1' })).toEqual({
      kind: 'host',
      hostId: 'host-1'
    })
    expect(
      getNotificationNavigationTarget({ hostId: 'host-1', worktreeId: 'repo::/tmp/worktree' })
    ).toEqual({
      kind: 'session',
      hostId: 'host-1',
      hostWorkspaceId: 'repo::/tmp/worktree'
    })
  })

  it('routes unavailable notification hosts through native recovery', () => {
    expect(
      notificationCredentialRecoveryRoute(
        getNotificationNavigationTarget(
          { hostId: 'host-1' },
          {
            credentialStatusByHostId: new Map([['host-1', 'temporarily-unavailable']])
          }
        )!
      )
    ).toBe('/')
    expect(
      notificationCredentialRecoveryRoute(
        getNotificationNavigationTarget(
          { hostId: 'host-1' },
          { credentialStatusByHostId: new Map([['host-1', 'missing']]) }
        )!
      )
    ).toBe('/pair-scan')
  })

  it('publishes the validated intent before entering the hybrid route', () => {
    const start = rootLayoutSource.indexOf('// ─── Notification tap routing ───')
    const end = rootLayoutSource.indexOf('// ─── End notification tap routing ───', start)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    const notificationEffect = rootLayoutSource.slice(start, end)
    expect(notificationEffect).toContain('MOBILE_WEB_NAVIGATION_INTENTS.publish(navigation.target)')
    expect(notificationEffect).toContain(
      'mobileHomeDestination(\n              navigation.target.hostId'
    )
    expect(notificationEffect).not.toContain('navigateToHostStackRoute(')
  })
})
