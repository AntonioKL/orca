import { beforeEach, describe, expect, it, vi } from 'vitest'

const { defaultSessionMock } = vi.hoisted(() => ({
  defaultSessionMock: {
    resolveProxy: vi.fn(async () => 'DIRECT'),
    setProxy: vi.fn(async () => {})
  }
}))

vi.mock('electron', () => ({
  session: {
    defaultSession: defaultSessionMock
  }
}))

import { applyProxySettingsToSession, resetSessionProxyApplicationForTests } from './proxy-settings'

function createProxySession() {
  return {
    resolveProxy: vi.fn(async () => 'DIRECT'),
    setProxy: vi.fn(async () => {}),
    closeAllConnections: vi.fn(async () => {})
  }
}

describe('applyProxySettingsToSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pins the configured proxy onto a non-default session', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)

    await expect(
      applyProxySettingsToSession(
        proxySession,
        {
          httpProxyUrl: ' socks5://127.0.0.1:1080/ ',
          httpProxyBypassRules: 'localhost, *.internal'
        },
        { env: {} }
      )
    ).resolves.toEqual({
      source: 'settings',
      proxyRules: 'socks5://127.0.0.1:1080',
      proxyBypassRules: 'localhost;*.internal'
    })

    expect(proxySession.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1080',
      proxyBypassRules: 'localhost;*.internal'
    })
    expect(proxySession.closeAllConnections).toHaveBeenCalledTimes(1)
  })

  it('does not touch defaultSession when applying to another session', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)

    await applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: '' },
      { env: {} }
    )

    expect(defaultSessionMock.setProxy).not.toHaveBeenCalled()
  })

  it('tracks applied config per session, so one session does not suppress another', async () => {
    const first = createProxySession()
    const second = createProxySession()
    resetSessionProxyApplicationForTests(first)
    resetSessionProxyApplicationForTests(second)
    const settings = { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: '' }

    await applyProxySettingsToSession(first, settings, { env: {} })
    await applyProxySettingsToSession(second, settings, { env: {} })

    expect(first.setProxy).toHaveBeenCalledTimes(1)
    expect(second.setProxy).toHaveBeenCalledTimes(1)
  })

  it('skips a redundant write when the same config is re-applied', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)
    const settings = { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: '' }

    await applyProxySettingsToSession(proxySession, settings, { env: {} })
    await applyProxySettingsToSession(proxySession, settings, { env: {} })

    expect(proxySession.setProxy).toHaveBeenCalledTimes(1)
  })

  it('falls back to the environment proxy when no proxy is configured', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)

    await expect(
      applyProxySettingsToSession(
        proxySession,
        { httpProxyUrl: '', httpProxyBypassRules: '' },
        { env: { HTTPS_PROXY: 'http://env.example:8080', NO_PROXY: 'localhost' } }
      )
    ).resolves.toEqual({
      source: 'env',
      proxyRules: 'http://env.example:8080',
      proxyBypassRules: 'localhost'
    })
    expect(proxySession.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://env.example:8080',
      proxyBypassRules: 'localhost'
    })
  })

  it('releases a previously pinned session back to the system proxy when settings are cleared', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)

    await applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: '' },
      { env: {} }
    )
    proxySession.setProxy.mockClear()

    await expect(
      applyProxySettingsToSession(
        proxySession,
        { httpProxyUrl: '', httpProxyBypassRules: '' },
        { env: {} }
      )
    ).resolves.toEqual({ source: 'none' })
    expect(proxySession.setProxy).toHaveBeenCalledWith({ mode: 'system' })
  })

  it('leaves an untouched session alone when nothing is configured', async () => {
    const proxySession = createProxySession()
    resetSessionProxyApplicationForTests(proxySession)

    await applyProxySettingsToSession(
      proxySession,
      { httpProxyUrl: '', httpProxyBypassRules: '' },
      { env: {} }
    )

    expect(proxySession.setProxy).not.toHaveBeenCalled()
  })
})
