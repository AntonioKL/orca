import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import {
  mobileWebUserGestureConsumer,
  requireRecentUserGesture
} from './mobile-web-user-gesture-requirement'

const DIRECTORY = import.meta.dirname + '/'

// Every operation whose gate must survive a refactor. A gate added without a row here fails, and a
// row whose gate is deleted fails.
const GESTURE_GATED_DISCRIMINATORS: Record<string, string[]> = {
  'mobile-web-account-operations.ts': ['consumeResetCredit', 'select'],
  'mobile-web-agent-history-operations.ts': ['resume'],
  'mobile-web-native-capability-operations.ts': [
    'clipboardWrite',
    'openExternal',
    'terminalCustomKeysUpdate',
    'terminalTextScaleUpdate'
  ],
  'mobile-web-native-chat-image-operations.ts': ['attachImage'],
  'mobile-web-navigation-operations.ts': ['reconnect', 'removeHost', 'terminalSettings'],
  'mobile-web-speech-operations.ts': ['configure', 'deleteModel', 'downloadModel', 'start'],
  'mobile-web-terminal-streams.ts': ['attachImage', 'clipboardPaste'],
  'mobile-web-workspace-creation-create-operations.ts': [
    'creationCreateBlank',
    'creationCreateFromSource'
  ]
}

describe('mobile web user gesture requirement census', () => {
  it('routes every gesture gate through the one shared requirement', () => {
    const gated = readdirSync(DIRECTORY).filter(
      (name) =>
        name.endsWith('.ts') &&
        !name.endsWith('.test.ts') &&
        name !== 'mobile-web-user-gesture-requirement.ts' &&
        readFileSync(DIRECTORY + name, 'utf8').includes('requireRecentUserGesture(')
    )

    expect(gated.toSorted()).toEqual(Object.keys(GESTURE_GATED_DISCRIMINATORS).toSorted())
    for (const name of gated) {
      expect([name, guardedDiscriminators(readFileSync(DIRECTORY + name, 'utf8'))]).toEqual([
        name,
        GESTURE_GATED_DISCRIMINATORS[name]
      ])
    }
  })

  it('leaves no open-coded permission_required gesture check behind', () => {
    for (const name of readdirSync(DIRECTORY).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts')
    )) {
      const source = readFileSync(DIRECTORY + name, 'utf8')
      expect([
        name,
        /consumeRecentUserGesture\(\)\s*\)?\s*\{[\s\S]{0,80}permission_required/.test(source)
      ]).toEqual([name, false])
    }
  })

  it('denies when the gesture is absent, stale, or unplumbed', () => {
    expect(() => requireRecentUserGesture(() => false)).toThrow(MobileWebBrokerError)
    expect(() => requireRecentUserGesture(undefined)).toThrow(
      expect.objectContaining({ code: 'permission_required' })
    )
    expect(() => requireRecentUserGesture(() => true)).not.toThrow()
  })

  it('denies through the consumer when no navigation authority is plumbed', () => {
    expect(mobileWebUserGestureConsumer(undefined)()).toBe(false)
    expect(
      mobileWebUserGestureConsumer({
        route: () => {},
        reconnect: () => {},
        removeHost: () => {},
        consumeRecentUserGesture: () => true
      })()
    ).toBe(true)
  })

  it('spends the gesture exactly once so a replayed request is denied', () => {
    let gestures = 1
    const consume = mobileWebUserGestureConsumer({
      route: () => {},
      reconnect: () => {},
      removeHost: () => {},
      consumeRecentUserGesture: () => gestures-- > 0
    })

    expect(() => requireRecentUserGesture(consume)).not.toThrow()
    expect(() => requireRecentUserGesture(consume)).toThrow(
      expect.objectContaining({ code: 'permission_required' })
    )
  })
})

// The discriminators of the `if` condition guarding each requireRecentUserGesture call.
function guardedDiscriminators(source: string): string[] {
  const names = new Set<string>()
  for (const call of source.matchAll(/requireRecentUserGesture\(/g)) {
    const guardStart = source.lastIndexOf('if (', call.index)
    expect(guardStart).toBeGreaterThan(-1)
    for (const match of source.slice(guardStart, call.index).matchAll(/=== '([A-Za-z]+)'/g)) {
      names.add(match[1]!)
    }
  }
  return [...names].toSorted()
}
