// Only ENOENT proves the WAL is empty.
//
// `journalWalBytes` feeds two decisions: the deferred-checkpoint term in
// admission, and the empty-WAL predicate reclamation refuses to run without.
// Reporting an unknown stat failure as zero undercharges the first and lets the
// second proceed on a false premise, so everything but ENOENT fails closed.

import type * as FsPromises from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'

const stat = vi.hoisted(() => vi.fn())

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, stat }
})

const { journalWalBytes } = await import('./journal-database-space')

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`stat failed: ${code}`), { code })
}

describe('journalWalBytes', () => {
  it('reports the WAL size when the file is there', async () => {
    stat.mockResolvedValueOnce({ size: 4_120 })
    expect(await journalWalBytes('/journal/journal.db')).toBe(4_120)
    expect(stat).toHaveBeenCalledWith('/journal/journal.db-wal')
  })

  it('reports zero for ENOENT, the one error that proves absence', async () => {
    stat.mockRejectedValueOnce(errno('ENOENT'))
    expect(await journalWalBytes('/journal/journal.db')).toBe(0)
  })

  it.each(['EACCES', 'EIO', 'ELOOP', 'ENOTDIR', 'EPERM', undefined])(
    'propagates %s rather than claiming the WAL is empty',
    async (code) => {
      stat.mockRejectedValueOnce(
        code === undefined ? new Error('stat failed with no code') : errno(code)
      )
      await expect(journalWalBytes('/journal/journal.db')).rejects.toThrow(/stat failed/)
    }
  )
})
