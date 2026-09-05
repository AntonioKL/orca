import { readFile } from 'node:fs/promises'
import type { ProcessTableRow } from './process-table-snapshot'

/** Read Linux's stable PID start-time ticks without spawning another process. */
export async function readLinuxProcessStartTimes(
  rows: readonly ProcessTableRow[]
): Promise<ReadonlyMap<number, string> | undefined> {
  if (process.platform !== 'linux') {
    return undefined
  }
  const candidates = rows.filter((row) => row.tty !== undefined && row.tty !== '?')
  const starts = await Promise.all(
    candidates.map(async (row) => {
      try {
        const stat = await readFile(`/proc/${row.pid}/stat`, 'utf8')
        const closingParen = stat.lastIndexOf(')')
        if (closingParen === -1) {
          return null
        }
        const tail = stat
          .slice(closingParen + 1)
          .trim()
          .split(/\s+/)
        const startTime = tail[19]
        return startTime ? ([row.pid, startTime] as const) : null
      } catch {
        return null
      }
    })
  )
  const result = new Map<number, string>()
  for (const entry of starts) {
    if (entry) {
      result.set(entry[0], entry[1])
    }
  }
  return result
}
