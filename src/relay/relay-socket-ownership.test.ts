import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const { statSyncMock, unlinkSyncMock, createConnectionMock } = vi.hoisted(() => ({
  statSyncMock: vi.fn(),
  unlinkSyncMock: vi.fn(),
  createConnectionMock: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    statSync: statSyncMock,
    unlinkSync: unlinkSyncMock
  }
})

vi.mock('node:net', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    createConnection: createConnectionMock
  }
})

import { RelaySocketOwnership } from './relay-socket-ownership'

describe('RelaySocketOwnership stale-path guard', () => {
  it('unlinks after a definitive ECONNREFUSED probe', () => {
    const ownership = new RelaySocketOwnership('/tmp/relay.sock')
    const blockedIdentity = { dev: 1n, ino: 2n, ctimeNs: 3n }
    const probe = new EventEmitter()
    createConnectionMock.mockReset().mockReturnValue(probe)
    statSyncMock.mockReset().mockReturnValue(blockedIdentity)
    unlinkSyncMock.mockReset()
    const retry = vi.fn()
    const fail = vi.fn()

    ;(
      ownership as unknown as {
        probeBlockedPath(
          error: NodeJS.ErrnoException,
          fail: (error: NodeJS.ErrnoException) => void,
          retry: () => void
        ): void
      }
    ).probeBlockedPath(
      Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }),
      fail,
      retry
    )
    probe.emit('error', Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }))

    expect(retry).toHaveBeenCalledOnce()
    expect(fail).not.toHaveBeenCalled()
    expect(unlinkSyncMock).toHaveBeenCalledWith('/tmp/relay.sock')
  })

  it('does not unlink when the socket identity changes after the probe', () => {
    const ownership = new RelaySocketOwnership('/tmp/relay.sock')
    const blockedIdentity = { dev: 1n, ino: 2n, ctimeNs: 3n }
    const replacementIdentity = { dev: 1n, ino: 4n, ctimeNs: 5n }
    const probe = new EventEmitter()
    createConnectionMock.mockReset().mockReturnValue(probe)
    statSyncMock
      .mockReset()
      .mockReturnValueOnce(blockedIdentity)
      .mockReturnValueOnce(replacementIdentity)
    unlinkSyncMock.mockReset()
    const retry = vi.fn()
    const fail = vi.fn()

    ;(
      ownership as unknown as {
        probeBlockedPath(
          error: NodeJS.ErrnoException,
          fail: (error: NodeJS.ErrnoException) => void,
          retry: () => void
        ): void
      }
    ).probeBlockedPath(
      Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }),
      fail,
      retry
    )
    probe.emit('error', Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }))

    expect(retry).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledOnce()
    expect(unlinkSyncMock).not.toHaveBeenCalled()
  })
})
