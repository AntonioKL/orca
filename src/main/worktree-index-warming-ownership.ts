import { open, rm, writeFile } from 'node:fs/promises'
import { hasExitedPosixProcessGroup } from '../shared/child-process/process-tree-termination'

function markerPath(preparedPath: string): string {
  return `${preparedPath}.index-warming`
}

/** The pending marker precedes spawn; an interrupted PID write remains unverifiable. */
export class WorktreeIndexWarmingOwnership {
  private pidWrite: Promise<void> = Promise.resolve()
  constructor(private readonly preparedPath: string) {}

  arm(): Promise<void> {
    return writeFile(markerPath(this.preparedPath), 'pending\n', { flag: 'wx' })
  }

  recordPid(pid: number): void {
    this.pidWrite = writeFile(markerPath(this.preparedPath), `${pid}\n`).catch(() => {})
  }

  async release(): Promise<void> {
    await this.pidWrite
    await rm(markerPath(this.preparedPath), { force: true })
  }
}

export async function canReclaimIndexWarming(
  preparedPath: string,
  wslDistro?: string
): Promise<boolean> {
  // A Mac process-group id is not evidence on another execution host.
  if (process.platform !== 'darwin' || wslDistro) {
    return false
  }
  try {
    const file = await open(markerPath(preparedPath), 'r')
    let text: string
    try {
      const buffer = Buffer.alloc(32)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead === buffer.length) {
        return false
      }
      text = buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
    if (!/^[1-9]\d*\n$/.test(text)) {
      return false
    }
    return hasExitedPosixProcessGroup(Number(text.trim()))
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

export function removeIndexWarmingOwnership(preparedPath: string): Promise<void> {
  return rm(markerPath(preparedPath), { force: true })
}
