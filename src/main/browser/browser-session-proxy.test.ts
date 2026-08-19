import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sessionsByPartition, fromPartitionMock } = vi.hoisted(() => {
  const sessionsByPartition = new Map<string, Record<string, ReturnType<typeof vi.fn>>>()
  const fromPartitionMock = vi.fn((partition: string) => {
    const existing = sessionsByPartition.get(partition)
    if (existing) {
      return existing
    }
    const created = {
      resolveProxy: vi.fn(async () => 'DIRECT'),
      setProxy: vi.fn(async () => {}),
      closeAllConnections: vi.fn(async () => {})
    }
    sessionsByPartition.set(partition, created)
    return created
  })
  return { sessionsByPartition, fromPartitionMock }
})

vi.mock('electron', () => ({
  session: {
    defaultSession: { resolveProxy: vi.fn(async () => 'DIRECT'), setProxy: vi.fn(async () => {}) },
    fromPartition: fromPartitionMock
  }
}))

import {
  applyBrowserSessionProxies,
  applyProxyToBrowserSession,
  setBrowserNetworkProxySettingsResolver
} from './browser-session-proxy'
import { resetSessionProxyApplicationForTests } from '../network/proxy-settings'

const PROFILES = [
  {
    id: 'default',
    scope: 'default' as const,
    partition: 'persist:orca-browser',
    label: 'Default',
    source: null
  },
  {
    id: 'iso',
    scope: 'isolated' as const,
    partition: 'persist:orca-browser-session-iso',
    label: 'Isolated',
    source: null
  }
]

describe('browser session proxy', () => {
  beforeEach(() => {
    for (const sess of sessionsByPartition.values()) {
      resetSessionProxyApplicationForTests(sess as never)
    }
    sessionsByPartition.clear()
    fromPartitionMock.mockClear()
    setBrowserNetworkProxySettingsResolver(null)
  })

  // Why (STA-4779): browser guests run on their own partitions, so a proxy pinned only to
  // defaultSession left every embedded tab going direct.
  it('pins the configured proxy onto every browser partition', async () => {
    await applyBrowserSessionProxies(PROFILES, {
      httpProxyUrl: 'socks5://127.0.0.1:1080',
      httpProxyBypassRules: ''
    })

    expect(fromPartitionMock).toHaveBeenCalledWith('persist:orca-browser')
    expect(fromPartitionMock).toHaveBeenCalledWith('persist:orca-browser-session-iso')
    for (const partition of PROFILES.map((p) => p.partition)) {
      expect(sessionsByPartition.get(partition)?.setProxy).toHaveBeenCalledWith({
        mode: 'fixed_servers',
        proxyRules: 'socks5://127.0.0.1:1080'
      })
    }
  })

  it('carries bypass rules through to each partition', async () => {
    await applyBrowserSessionProxies(PROFILES, {
      httpProxyUrl: 'socks5://127.0.0.1:1080',
      httpProxyBypassRules: 'localhost, *.internal'
    })

    expect(sessionsByPartition.get('persist:orca-browser')?.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1080',
      proxyBypassRules: 'localhost;*.internal'
    })
  })

  it('keeps sweeping the remaining profiles when one partition throws', async () => {
    fromPartitionMock.mockImplementationOnce(() => {
      throw new Error('partition unavailable')
    })

    await applyBrowserSessionProxies(PROFILES, {
      httpProxyUrl: 'socks5://127.0.0.1:1080',
      httpProxyBypassRules: ''
    })

    expect(
      sessionsByPartition.get('persist:orca-browser-session-iso')?.setProxy
    ).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1080' })
  })

  it('reads settings through the injected resolver when none are passed', async () => {
    setBrowserNetworkProxySettingsResolver(() => ({
      httpProxyUrl: 'socks5://127.0.0.1:1080',
      httpProxyBypassRules: ''
    }))
    const sess = fromPartitionMock('persist:orca-browser')

    await applyProxyToBrowserSession(sess as never)

    expect(sess.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:1080'
    })
  })

  it('makes no proxy write when no resolver is registered', async () => {
    const sess = fromPartitionMock('persist:orca-browser')

    await applyProxyToBrowserSession(sess as never)

    expect(sess.setProxy).not.toHaveBeenCalled()
  })
})
