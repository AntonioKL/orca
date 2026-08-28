import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

export async function inspectProcessChildren(pid: number): Promise<{
  hasChildProcesses: boolean
  unavailable?: true
}> {
  try {
    const { stdout } = await execFile('pgrep', ['-P', String(pid)], {
      encoding: 'utf-8',
      timeout: 3000
    })
    return { hasChildProcesses: stdout.trim().length > 0 }
  } catch (error) {
    if ((error as { code?: string | number }).code === 1) {
      return { hasChildProcesses: false }
    }
    return { hasChildProcesses: false, unavailable: true }
  }
}
