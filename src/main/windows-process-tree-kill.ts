import { execFile } from 'node:child_process'
import {
  recordRefusedOwnChromiumTreeKill,
  recordSelfInitiatedTreeKill
} from './crash-reporting/self-initiated-tree-kill-log'
import { readOrcaChromiumProcessPids } from './orca-chromium-process-pids'

export type WindowsTreeKiller = (rootPid: number, deps?: { site?: string }) => Promise<void>

/** Bound hung taskkill so killRoot still runs in killWithDescendantSweep. */
export const WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS = 5_000

/**
 * Force-kill a Windows process and every descendant (`taskkill /T /F`).
 * Best-effort: missing/already-dead roots still resolve so callers can finish
 * their own handle cleanup via killRoot.
 *
 * This is the main process's single taskkill choke point, so it is also where
 * the self-kill breadcrumb and the own-Chromium refusal live — instrumenting
 * callers instead would rot the first time one is added.
 */
export function terminateWindowsProcessTree(
  rootPid: number,
  deps: { execFileImpl?: typeof execFile; site?: string } = {}
): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return Promise.resolve()
  }
  const site = deps.site ?? 'windows-process-tree-kill'
  // Why: no PTY root, codex root or git child is ever one of our own Chromium
  // processes, so a pid that is means the caller is about to kill a renderer,
  // the GPU or the browser itself (#10680).
  if (readOrcaChromiumProcessPids().has(rootPid)) {
    recordRefusedOwnChromiumTreeKill({ pid: rootPid, site, scope: 'win-taskkill-tree' })
    return Promise.resolve()
  }
  recordSelfInitiatedTreeKill({ pid: rootPid, site, scope: 'win-taskkill-tree' })
  const run = deps.execFileImpl ?? execFile
  return new Promise((resolve) => {
    run(
      'taskkill',
      ['/pid', String(rootPid), '/T', '/F'],
      {
        // Why: a wedged taskkill must not block killRoot forever (#10004 review).
        timeout: WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS,
        windowsHide: true
      },
      () => {
        resolve()
      }
    )
  })
}
