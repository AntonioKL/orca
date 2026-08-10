import { describe, expect, it, vi } from 'vitest'
import { restartPairedHostClient } from './restart-paired-host-client'

describe('restartPairedHostClient', () => {
  it('starts reconnect without blocking successful pairing navigation', () => {
    const closeHost = vi.fn()
    const forceReconnect = vi.fn(() => new Promise<void>(() => {}))

    const result = restartPairedHostClient('host-1', closeHost, forceReconnect)

    expect(result).toBeUndefined()
    expect(closeHost).toHaveBeenCalledWith('host-1')
    expect(forceReconnect).toHaveBeenCalledWith('host-1')
  })

  it('contains a background reconnect rejection', async () => {
    const forceReconnect = vi.fn(async () => {
      throw new Error('host storage unavailable')
    })

    restartPairedHostClient('host-1', vi.fn(), forceReconnect)
    await Promise.resolve()

    expect(forceReconnect).toHaveBeenCalledOnce()
  })
})
