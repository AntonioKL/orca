import { describe, expect, it, vi } from 'vitest'
import {
  captureWindowsDescendantSnapshot,
  verifyWindowsDescendantSnapshotExit,
  type WindowsDescendantSnapshot
} from './windows-descendant-exit-verification'

function snapshot(
  descendants: { pid: number; creationTimeMs: number }[]
): WindowsDescendantSnapshot {
  return { descendants, capturedAtMs: 1_700_000_000_000 }
}

describe('captureWindowsDescendantSnapshot', () => {
  it('walks the whole subtree and keeps only rows a later read can re-identify', async () => {
    const captured = await captureWindowsDescendantSnapshot(100, {
      // 400 is a grandchild; 300 denied a creation-time query, so no later read
      // could tell it from a recycled pid and signalling it would risk a stranger.
      readTable: vi.fn(async () => [
        { pid: 100, ppid: 1, creationTimeMs: 5 },
        { pid: 200, ppid: 100, creationTimeMs: 7 },
        { pid: 300, ppid: 100 },
        { pid: 400, ppid: 200, creationTimeMs: 9 },
        { pid: 500, ppid: 1, creationTimeMs: 11 }
      ]),
      now: () => 42
    })

    expect(captured).toEqual({
      descendants: [
        { pid: 400, creationTimeMs: 9 },
        { pid: 200, creationTimeMs: 7 }
      ],
      capturedAtMs: 42
    })
  })

  it('reports an unreadable or rootless table as no snapshot rather than an empty one', async () => {
    await expect(
      captureWindowsDescendantSnapshot(100, {
        readTable: vi.fn(async () => {
          throw new Error('table unavailable')
        })
      })
    ).resolves.toBeNull()
    // A snapshot without the root is stale or filtered; only an observed root
    // can authoritatively have no descendants.
    await expect(
      captureWindowsDescendantSnapshot(100, {
        readTable: vi.fn(async () => [{ pid: 999, ppid: 1, creationTimeMs: 5 }])
      })
    ).resolves.toBeNull()
  })

  it('refuses an invalid root pid', async () => {
    const readTable = vi.fn()
    await expect(captureWindowsDescendantSnapshot(0, { readTable })).resolves.toBeNull()
    expect(readTable).not.toHaveBeenCalled()
  })
})

describe('verifyWindowsDescendantSnapshotExit', () => {
  it('proves an empty tree without reading the table', async () => {
    const readTable = vi.fn()
    await expect(verifyWindowsDescendantSnapshotExit(snapshot([]), { readTable })).resolves.toBe(
      'exited'
    )
    expect(readTable).not.toHaveBeenCalled()
  })

  it('reports exited once no identity-matched row remains', async () => {
    const readTable = vi
      .fn()
      .mockResolvedValueOnce([{ pid: 200, ppid: 100, creationTimeMs: 7 }])
      // The pid came back on a different process; that is a recycle, not a survivor.
      .mockResolvedValueOnce([{ pid: 200, ppid: 100, creationTimeMs: 99 }])

    await expect(
      verifyWindowsDescendantSnapshotExit(snapshot([{ pid: 200, creationTimeMs: 7 }]), {
        readTable,
        wait: async () => {},
        now: vi.fn().mockReturnValueOnce(0).mockReturnValue(1)
      })
    ).resolves.toBe('exited')
    expect(readTable).toHaveBeenCalledTimes(2)
  })

  it('reports live for a descendant still matched at the deadline', async () => {
    let clock = 0
    await expect(
      verifyWindowsDescendantSnapshotExit(snapshot([{ pid: 200, creationTimeMs: 7 }]), {
        readTable: vi.fn(async () => [{ pid: 200, ppid: 100, creationTimeMs: 7 }]),
        wait: async () => {
          clock += 100
        },
        now: () => clock,
        verifyMs: 250
      })
    ).resolves.toBe('live')
  })

  it('reports unverifiable when the table cannot be read at the deadline', async () => {
    await expect(
      verifyWindowsDescendantSnapshotExit(snapshot([{ pid: 200, creationTimeMs: 7 }]), {
        readTable: vi.fn(async () => {
          throw new Error('table unavailable')
        }),
        wait: async () => {},
        now: vi.fn().mockReturnValueOnce(0).mockReturnValue(9_999)
      })
    ).resolves.toBe('unverifiable')
  })
})
