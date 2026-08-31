import { win32 as pathWin32 } from 'node:path'

/** Absolute path, so PATH cannot be hijacked the way it was for PowerShell (#15749). */
let cached: string | undefined

export function resolveWslExecutablePath(): string {
  if (cached !== undefined) {
    return cached
  }
  // WSL is a Windows-only executable. On Windows, resolving it by bare name
  // lets a repository-controlled PATH entry shadow the system binary (and is
  // particularly easy to trigger from an Electron-launched process).
  if (process.platform !== 'win32') {
    return (cached = 'wsl.exe')
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  return (cached = pathWin32.join(systemRoot, 'System32', 'wsl.exe'))
}
