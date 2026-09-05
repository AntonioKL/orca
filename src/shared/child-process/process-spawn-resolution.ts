import type { SpawnOptions as NodeSpawnOptions } from 'node:child_process'
import type { ProcessSpec } from './process-spec'
import { buildWindowsCmdShimCommandLine, isCmdInterpretedProgram } from './windows-command-line'

export type ResolvedSpawn = {
  file: string
  args: readonly string[]
  options: NodeSpawnOptions
}

/**
 * Translate a spec into the exact `child_process.spawn` call to make.
 *
 * Kept pure and exported so the Windows branch is testable from macOS/Linux:
 * the decisions below are the whole point of this module, and they must not be
 * observable only on the platform that breaks.
 */
export function resolveSpawn(spec: ProcessSpec, platform: NodeJS.Platform): ResolvedSpawn {
  const args = spec.args ?? []
  const base: NodeSpawnOptions = {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe'],
    // Why unconditional: Orca's main process is GUI-subsystem and owns no
    // console, so every console-subsystem child it starts gets a fresh visible
    // conhost that takes foreground — keystrokes typed into an Orca terminal at
    // that moment land in the black box instead.
    windowsHide: true,
    detached: spec.detached,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    // Why never `shell: true`: it concatenates arguments without escaping (Node
    // itself warns DEP0190) and it silently makes windowsHide a no-op.
    shell: false,
    ...(spec.terminationBarrier && platform !== 'win32' ? { detached: true } : {})
  }

  if (platform !== 'win32' || !isCmdInterpretedProgram(spec.program)) {
    return { file: spec.program, args, options: base }
  }

  // Node refuses to spawn `.cmd`/`.bat` without a shell (EINVAL, the
  // CVE-2024-27980 mitigation), so cmd.exe has to be the program. Building the
  // line ourselves — rather than handing Node `shell: true` — is what keeps the
  // arguments intact and the console hidden.
  const comSpec = spec.env?.ComSpec ?? process.env.ComSpec ?? 'cmd.exe'
  return {
    file: comSpec,
    args: [buildWindowsCmdShimCommandLine(spec.program, args)],
    options: { ...base, windowsVerbatimArguments: true }
  }
}
