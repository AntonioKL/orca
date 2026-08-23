import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installElectronProxyRequestGuard } from './electron-proxy-request-guard'
import { applyProxySettingsToSession, resetSessionProxyApplicationForTests } from './proxy-settings'

function createSession() {
  let listener:
    | ((details: unknown, callback: (result: { cancel?: boolean }) => void) => void)
    | null = null
  const proxySession = {
    resolveProxy: vi.fn(async () => 'DIRECT'),
    setProxy: vi.fn(async () => {}),
    closeAllConnections: vi.fn(async () => {}),
    webRequest: {
      onBeforeRequest: vi.fn(
        (
          next:
            | ((details: unknown, callback: (result: { cancel?: boolean }) => void) => void)
            | null
        ) => {
          listener = next
        }
      )
    }
  }
  return {
    proxySession,
    request: (callback: (result: { cancel?: boolean }) => void) => listener?.({}, callback)
  }
}

describe('default-session proxy request guard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('holds renderer requests until a delayed proxy transition settles', async () => {
    const { proxySession, request } = createSession()
    let finishWrite: (() => void) | undefined
    proxySession.setProxy.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishWrite = resolve))
    )
    resetSessionProxyApplicationForTests(proxySession)
    installElectronProxyRequestGuard(proxySession as never)

    const applying = applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'http://proxy.example:8080' },
      { env: {} }
    )
    const callback = vi.fn()
    request(callback)
    expect(callback).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(proxySession.setProxy).toHaveBeenCalledOnce())
    finishWrite?.()
    await applying
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({}))
  })

  it('cancels renderer requests after proxy application fails', async () => {
    const { proxySession, request } = createSession()
    proxySession.setProxy.mockRejectedValueOnce(new Error('proxy apply failed'))
    resetSessionProxyApplicationForTests(proxySession)
    installElectronProxyRequestGuard(proxySession as never)

    await expect(
      applyProxySettingsToSession(
        proxySession,
        { httpProxyUrl: 'http://proxy.example:8080' },
        { env: {} }
      )
    ).rejects.toThrow('proxy apply failed')
    const callback = vi.fn()
    request(callback)

    expect(callback).toHaveBeenCalledWith({ cancel: true })
  })
})
