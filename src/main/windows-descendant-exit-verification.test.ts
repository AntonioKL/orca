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
  it('keeps only descendants the table can re-identify by creation time', async () => {
    const captured = await captureWindowsDescendantSnapshot(100, {
      readDescendants: vi.fn(async () => [{ pid: 200 }, { pid: 300 }]),
      // 300 denied a creation-time query, so no later read could tell it from a
      // recycled pid; signalling it would risk an unrelated process.
      readTable: vi.fn(async () => [
        { pid: 100, creationTimeMs: 5 },
        { pid: 200, creationTimeMs: 7 },
        { pid: 300 }
      ]),
      now: () => 42
    })

    expect(captured).toEqual({ descendants: [{ pid: 200, creationTimeMs: 7 }], capturedAtMs: 42 })
  })

  it('reports an unreadable descendant walk as no snapshot rather than an empty one', async () => {
    await expect(
      captureWindowsDescendantSnapshot(100, { readDescendants: vi.fn(async () => null) })
    ).resolves.toBeNull()
    await expect(
      captureWindowsDescendantSnapshot(100, {
        readDescendants: vi.fn(async () => [{ pid: 200 }]),
        readTable: vi.fn(async () => {
          throw new Error('table unavailable')
        })
      })
    ).resolves.toBeNull()
  })

  it('refuses an invalid root pid', async () => {
    const readDescendants = vi.fn()
    await expect(captureWindowsDescendantSnapshot(0, { readDescendants })).resolves.toBeNull()
    expect(readDescendants).not.toHaveBeenCalled()
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
      .mockResolvedValueOnce([{ pid: 200, creationTimeMs: 7 }])
      // The pid came back on a different process; that is a recycle, not a survivor.
      .mockResolvedValueOnce([{ pid: 200, creationTimeMs: 99 }])

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
        readTable: vi.fn(async () => [{ pid: 200, creationTimeMs: 7 }]),
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
