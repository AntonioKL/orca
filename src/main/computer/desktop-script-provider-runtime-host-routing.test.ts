import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bridgeProcessArgs,
  createDesktopScriptProviderClient,
  expectDesktopProviderSubprocessStartCount,
  mockBridgeProcessFailure,
  mockBridgeResponse,
  resetDesktopScriptProviderTestHarness,
  sampleCapabilities
} from './desktop-script-provider-test-harness'
import type { BridgeResponse } from './desktop-script-provider-types'
import type { DesktopScriptRuntimeHost } from './desktop-script-runtime-host'
import { RuntimeClientError } from './runtime-client-error'

const POLICY_STDERR =
  'File runtime.ps1 cannot be loaded because running scripts is disabled on this system. + CategoryInfo : SecurityError'

function fakeRuntimeHost(request: DesktopScriptRuntimeHost['request']) {
  const dispose = vi.fn()
  return { host: { request, dispose } as unknown as DesktopScriptRuntimeHost, dispose }
}

describe('desktop script provider runtime host routing', () => {
  afterEach(resetDesktopScriptProviderTestHarness)

  it('serves Windows operations from the runtime host without spawning a one-shot bridge', async () => {
    const request = vi.fn(
      async () => ({ ok: true, capabilities: sampleCapabilities() }) as BridgeResponse
    )
    const { host } = fakeRuntimeHost(request)

    const client = await createDesktopScriptProviderClient('windows', 'C:\\runtime.ps1', host)

    await expect(client.capabilities()).resolves.toMatchObject({ platform: 'linux' })
    expect(request).toHaveBeenCalledWith({ tool: 'handshake' })
    expectDesktopProviderSubprocessStartCount(0)
  })

  it('maps runtime host operation failures without falling back to the one-shot bridge', async () => {
    const { host } = fakeRuntimeHost(
      vi.fn(async () => ({ ok: false, error: 'appBlocked("1Password")' }) as BridgeResponse)
    )

    const client = await createDesktopScriptProviderClient('windows', 'C:\\runtime.ps1', host)

    await expect(client.listApps()).rejects.toMatchObject({ code: 'app_blocked' })
    expectDesktopProviderSubprocessStartCount(0)
  })

  it('degrades to the one-shot bridge when the runtime host cannot start', async () => {
    const request = vi.fn(async () => {
      throw new RuntimeClientError('runtime_host_unavailable', 'could not start')
    })
    const { host, dispose } = fakeRuntimeHost(request as never)
    mockBridgeResponse({ ok: true, apps: [{ name: 'Notepad', pid: 42 }] })
    mockBridgeResponse({ ok: true, apps: [{ name: 'Notepad', pid: 42 }] })

    const client = await createDesktopScriptProviderClient('windows', 'C:\\runtime.ps1', host)

    await expect(client.listApps()).resolves.toMatchObject({ apps: [{ pid: 42 }] })
    expect(dispose).toHaveBeenCalled()

    // The host is dropped for the session rather than re-probed per operation.
    await client.listApps()
    expect(request).toHaveBeenCalledTimes(1)
    expectDesktopProviderSubprocessStartCount(2)
  })

  it('runs the one-shot bridge under RemoteSigned and falls back to Bypass once', async () => {
    mockBridgeProcessFailure(POLICY_STDERR)
    mockBridgeResponse({ ok: true, apps: [] })

    const client = await createDesktopScriptProviderClient('windows', 'C:\\runtime.ps1')

    await expect(client.listApps()).resolves.toEqual({ apps: [] })
    expectDesktopProviderSubprocessStartCount(2)
    expect(bridgeProcessArgs(0)).toContain('RemoteSigned')
    expect(bridgeProcessArgs(0)).not.toContain('Bypass')
    expect(bridgeProcessArgs(1)).toContain('Bypass')
  })

  it('does not retry the one-shot bridge for a non-policy failure', async () => {
    mockBridgeProcessFailure('No top-level UI Automation window is available for Notepad')

    const client = await createDesktopScriptProviderClient('windows', 'C:\\runtime.ps1')

    await expect(client.listApps()).rejects.toMatchObject({ code: 'window_not_found' })
    expectDesktopProviderSubprocessStartCount(1)
  })

  it('keeps Linux on the one-shot python bridge with no execution policy flags', async () => {
    mockBridgeResponse({ ok: true, apps: [] })

    const client = await createDesktopScriptProviderClient('linux', '/tmp/runtime.py')

    await expect(client.listApps()).resolves.toEqual({ apps: [] })
    expect(bridgeProcessArgs(0)).toEqual(['/tmp/runtime.py', expect.any(String)])
  })
})
