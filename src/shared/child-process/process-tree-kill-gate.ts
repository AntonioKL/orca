/**
 * Seam that lets the main process decide, and record, the tree-kills issued
 * from code it does not own.
 *
 * Why a seam and not a direct call: `signalProcessTree` is the choke point every
 * `runProcess` termination funnels through, and the codex app-server and
 * ephemeral-VM kills are shared with the CLI — all of them live outside
 * `src/main` and cannot import the own-Chromium guard or the crash breadcrumb
 * store. Main registers the guard at startup; everywhere else this admits every
 * kill and records nothing.
 */

/** Blast radius, not mechanism: `win-taskkill-tree` is addressed by pid and walks
 *  whatever tree that pid has *now*, so it can land on a recycled pid that is
 *  since one of Orca's own Chromium processes. A process group can only contain
 *  processes Orca itself put there. */
export type ProcessTreeKillScope = 'win-taskkill-tree' | 'posix-process-group'

export type ProcessTreeKill = {
  pid: number
  site: string
  scope: ProcessTreeKillScope
}

/** False means the caller must not kill: main is currently accounting for that pid. */
type ProcessTreeKillGate = (kill: ProcessTreeKill) => boolean

let gate: ProcessTreeKillGate | null = null

export function setProcessTreeKillGate(next: ProcessTreeKillGate | null): void {
  gate = next
}

export function admitProcessTreeKill(kill: ProcessTreeKill): boolean {
  try {
    return gate?.(kill) ?? true
  } catch {
    // Diagnostics must never turn a successful termination into a failed one.
    return true
  }
}
