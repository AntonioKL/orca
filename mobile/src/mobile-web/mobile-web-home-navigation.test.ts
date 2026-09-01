import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebNavigationIntent } from './mobile-web-navigation-intent-buffer'
import { MOBILE_WEB_NAVIGATION_INTENTS } from './mobile-web-navigation-intent-buffer'
import {
  mobileHomeDestination,
  mobileHostWorkspaceEntry,
  navigateFromMobileHome
} from './mobile-web-home-navigation'

let latestIntent: MobileWebNavigationIntent | null = null
const unsubscribe = MOBILE_WEB_NAVIGATION_INTENTS.subscribe((intent) => {
  latestIntent = intent
})

afterEach(() => {
  if (latestIntent) {
    MOBILE_WEB_NAVIGATION_INTENTS.consume(latestIntent.sequence)
  }
  latestIntent = null
})

describe('mobile web Home navigation', () => {
  it('hands a typed destination to the selected architecture route', () => {
    const router = { push: vi.fn() }

    navigateFromMobileHome({
      router,
      hostId: 'host',
      target: { kind: 'tasks', taskSource: 'linear' },
      nativeBaselineEnabled: false
    })

    expect(router.push).toHaveBeenCalledWith('/hybrid?hostId=host')
    expect(latestIntent).toMatchObject({
      source: 'home',
      hostId: 'host',
      target: { kind: 'tasks', taskSource: 'linear' }
    })
  })

  it('encodes the post-pairing hosted route identity', () => {
    expect(mobileHostWorkspaceEntry('host/key?', false)).toBe('/hybrid?hostId=host%2Fkey%3F')
    expect(mobileHostWorkspaceEntry('host/key?', true)).toBe('/h/host%2Fkey%3F')
  })

  it('routes every parity baseline target through native presentation source', () => {
    expect(mobileHomeDestination('host/key', { kind: 'workspaceList' }, true)).toBe('/h/host%2Fkey')
    expect(
      mobileHomeDestination(
        'host/key',
        { kind: 'session', hostWorkspaceId: 'repo::/workspace' },
        true
      )
    ).toBe('/h/host%2Fkey/session/repo%3A%3A%2Fworkspace')
    expect(mobileHomeDestination('host/key', { kind: 'tasks', taskSource: 'linear' }, true)).toBe(
      '/h/host%2Fkey/tasks?taskSource=linear'
    )
    expect(mobileHomeDestination('host/key', { kind: 'accounts' }, true)).toBe(
      '/h/host%2Fkey/accounts'
    )
    expect(mobileHomeDestination('host/key', { kind: 'newWorkspace' }, true)).toBe(
      '/h/host%2Fkey?action=newWorktree'
    )
    expect(
      mobileHomeDestination('host/key', { kind: 'workspaceList', notice: 'worktree-missing' }, true)
    ).toBe('/h/host%2Fkey?notice=worktree-missing')
  })
})

afterAll(() => unsubscribe())
