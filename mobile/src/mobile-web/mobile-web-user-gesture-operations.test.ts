import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebAccountOperation } from './mobile-web-account-operations'
import { executeMobileWebNativeCapabilityOperation } from './mobile-web-native-capability-operations'
import { executeMobileWebNavigationOperation } from './mobile-web-navigation-operations'
import { executeMobileWebSpeechOperation } from './mobile-web-speech-operations'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import type { MobileWebSpeechAuthority } from './mobile-web-speech-authority'

type GatedCase = {
  name: string
  run: (consumeRecentUserGesture: () => boolean) => Promise<unknown>
}

const CASES: GatedCase[] = [
  nativeCase('clipboardWrite', { text: 'copied' }),
  nativeCase('openExternal', { url: 'https://example.invalid/docs' }),
  nativeCase('terminalTextScaleUpdate', { textScale: 1 }),
  nativeCase('terminalCustomKeysUpdate', { customKeys: [] }),
  speechCase('downloadModel', { modelId: 'tiny' }),
  speechCase('deleteModel', { modelId: 'tiny' }),
  speechCase('configure', { enabled: true }),
  speechCase('start', {}),
  accountCase('select', { provider: 'claude', accountId: null }),
  accountCase('consumeResetCredit', {
    expectedScope: {
      target: { runtime: 'host', wslDistro: null },
      accountId: 'account-1',
      accountRevision: 1,
      offerRevision: 'v1:offer'
    }
  }),
  navigationCase('route', { destination: 'terminalSettings' }),
  navigationCase('reconnect', {}),
  navigationCase('removeHost', { confirmation: 'remove-paired-host' })
]

describe.each(CASES)('gesture-gated $name', ({ run }) => {
  it('denies the operation without a recent user gesture', async () => {
    await expect(run(() => false)).rejects.toMatchObject({ code: 'permission_required' })
  })

  it('lets the operation past the gate with a recent user gesture', async () => {
    expect(await failureCode(run(() => true))).not.toBe('permission_required')
  })
})

describe('gesture-gated native alert', () => {
  const ALERT = {
    title: 'Discard changes?',
    buttons: [{ text: 'Stay', style: 'cancel' as const }]
  }

  it('denies an OS alert the page raises without a recent user gesture', async () => {
    await expect(runAlert(() => false)).rejects.toMatchObject({ code: 'permission_required' })
  })

  it('witnesses the gesture without spending it, so the confirmed action still has one', async () => {
    const consumeRecentUserGesture = vi.fn(() => true)

    await expect(runAlert(() => true, consumeRecentUserGesture)).resolves.toEqual({
      kind: 'dismissed'
    })
    expect(consumeRecentUserGesture).not.toHaveBeenCalled()
  })

  function runAlert(
    hasRecentUserGesture: () => boolean,
    consumeRecentUserGesture: () => boolean = () => true
  ): Promise<unknown> {
    return executeMobileWebNativeCapabilityOperation({
      operation: 'alert',
      payload: ALERT,
      authority: {
        alert: async () => ({ kind: 'dismissed' }),
        hapticFeedback: () => {}
      } as unknown as MobileWebNativeCapabilityAuthority,
      consumeRecentUserGesture,
      hasRecentUserGesture
    })
  }
})

describe('gesture-gated operations reached through other executors', () => {
  // These four gates share the same requirement but need host-side dependency graphs to reach, so
  // their denial is proven by the suites named here; the census pins that the gates still exist.
  it.each([
    ['resume', 'mobile-web-agent-history-roundtrip.test.ts'],
    ['attachImage', 'mobile-web-native-chat-image-operations.test.ts'],
    ['creationCreateBlank', 'mobile-web-workspace-creation-create-operations.test.ts'],
    ['clipboardPaste', 'mobile-web-terminal-streams.test.ts']
  ])('keeps a permission_required assertion for %s in %s', async (operation, file) => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    )

    expect(source).toContain(operation)
    expect(source).toContain('permission_required')
  })
})

async function failureCode(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => null,
    (error: unknown) => (error as { code?: unknown }).code
  )
}

function nativeCase(name: string, payload: unknown): GatedCase {
  return {
    name,
    run: (consumeRecentUserGesture) =>
      executeMobileWebNativeCapabilityOperation({
        operation: name,
        payload,
        authority: {
          hapticFeedback: () => {},
          clipboardAvailability: async () => ({ hasText: false, hasImage: false }),
          clipboardWrite: async () => ({ confirmation: 'in-app' }),
          openExternal: async () => {},
          terminalPreferences: async () => ({
            textScale: 1,
            autocompleteEnabled: true,
            linkOpenMode: 'phone-browser'
          }),
          terminalTextScaleUpdate: async () => {},
          terminalCustomKeysUpdate: async () => {}
        } as MobileWebNativeCapabilityAuthority,
        consumeRecentUserGesture,
        hasRecentUserGesture: () => false
      })
  }
}

function speechCase(name: string, payload: unknown): GatedCase {
  return {
    name,
    run: (consumeRecentUserGesture) =>
      executeMobileWebSpeechOperation({
        operation: name,
        payload,
        client: unavailableClient(),
        authority: {} as MobileWebSpeechAuthority,
        consumeRecentUserGesture
      })
  }
}

function accountCase(name: string, payload: unknown): GatedCase {
  return {
    name,
    run: (consumeRecentUserGesture) =>
      executeMobileWebAccountOperation({
        operation: name,
        payload,
        client: unavailableClient(),
        nativeAuthority: {} as MobileWebNativeCapabilityAuthority,
        consumeRecentUserGesture
      })
  }
}

function navigationCase(name: string, payload: unknown): GatedCase {
  return {
    name,
    run: (consumeRecentUserGesture) =>
      executeMobileWebNavigationOperation({
        requestId: 'R'.repeat(22),
        operation: name,
        payload,
        authority: {
          route: () => {},
          reconnect: () => {},
          removeHost: () => {},
          consumeRecentUserGesture
        }
      })
  }
}

function unavailableClient(): RpcClient {
  return {
    sendRequest: async () => ({ ok: false, error: { code: 'unavailable', message: 'no host' } })
  } as unknown as RpcClient
}
