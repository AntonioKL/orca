import type { CrashReportDetailValue } from '../../shared/crash-reporting'
import { recordDurableCrashBreadcrumb } from './durable-crash-breadcrumb'

/**
 * Records the force-kills Orca itself issues, so a later `render-process-gone`
 * can say whether we were holding the knife.
 *
 * Why: on Windows a `taskkill /T /F` we issue and an external one produce the
 * identical `reason=killed exitCode=1` plus the identical concurrent sibling
 * deaths — reproduced side by side on Windows 11 / Electron 43.4.1, differing in
 * zero recorded fields. This is the field that separates them.
 */

/** Which mechanism issued the kill; each has a different blast radius. */
export type SelfInitiatedTreeKillScope = 'win-taskkill-tree' | 'posix-process-group' | 'win-pty-job'

export type SelfInitiatedTreeKill = {
  pid: number
  site: string
  scope: SelfInitiatedTreeKillScope
  at: number
}

// Why 32 and not the sibling ring's 16: one teardown fans out over every root of
// a codex turn, so a single incident can spend a dozen entries on its own.
const MAX_TRACKED_SELF_KILLS = 32

// Why asymmetric: a kill older than this cannot plausibly explain the death,
// while the forward edge mirrors SIBLING_DEATH_LOOKAHEAD_MS — a kill issued just
// after the renderer died is at least as likely to be teardown reacting to it.
export const SELF_TREE_KILL_LOOKBACK_MS = 5_000
export const SELF_TREE_KILL_LOOKAHEAD_MS = 250

// Same truncation rule as MAX_SIBLING_DEATHS_DETAIL_LENGTH: drop whole entries
// rather than let sanitizeCrashReportDetails cut the list mid-token.
const MAX_SELF_TREE_KILLS_DETAIL_LENGTH = 200

let selfInitiatedKills: SelfInitiatedTreeKill[] = []

export function recordSelfInitiatedTreeKill({
  pid,
  site,
  scope,
  at = Date.now()
}: {
  pid: number
  site: string
  scope: SelfInitiatedTreeKillScope
  at?: number
}): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return
  }
  selfInitiatedKills.push({ pid, site, scope, at })
  if (selfInitiatedKills.length > MAX_TRACKED_SELF_KILLS) {
    selfInitiatedKills = selfInitiatedKills.slice(-MAX_TRACKED_SELF_KILLS)
  }
  // Durable so it survives into the diagnostic bundle even when the kill takes
  // the reporting renderer with it; durable breadcrumbs flush immediately.
  recordDurableCrashBreadcrumb('self_tree_kill', { pid, site, scope })
}

/**
 * A tree-kill we refused because the target is one of our own Chromium
 * processes. Falsifiable on purpose: this crumb appearing in a field bundle is
 * direct proof that Orca was about to kill its own renderer.
 */
export function recordRefusedOwnChromiumTreeKill(target: {
  pid: number
  site: string
  scope: SelfInitiatedTreeKillScope
}): void {
  recordDurableCrashBreadcrumb('self_tree_kill_refused_own_chromium', target)
}

export function findSelfInitiatedTreeKills(at: number): SelfInitiatedTreeKill[] {
  return selfInitiatedKills.filter((kill) => {
    const offsetMs = kill.at - at
    return offsetMs >= -SELF_TREE_KILL_LOOKBACK_MS && offsetMs <= SELF_TREE_KILL_LOOKAHEAD_MS
  })
}

// Why not `site:pid@offset`: sanitizeCrashReportString reads `word:word@` as a
// credential URL and redacts the whole token. Mirror describeChildDeath instead.
function describeSelfInitiatedTreeKill(kill: SelfInitiatedTreeKill, goneAt: number): string {
  const offsetMs = kill.at - goneAt
  return `${kill.site}/pid${kill.pid} ${offsetMs >= 0 ? '+' : ''}${offsetMs}ms`
}

/** Empty when Orca issued no nearby kill — absence is the discriminating half. */
export function selfInitiatedTreeKillDetails(
  goneAt: number
): Record<string, CrashReportDetailValue> {
  const kills = findSelfInitiatedTreeKills(goneAt)
  if (kills.length === 0) {
    return {}
  }
  const described = [...kills]
    .sort((a, b) => Math.abs(a.at - goneAt) - Math.abs(b.at - goneAt))
    .map((kill) => describeSelfInitiatedTreeKill(kill, goneAt))
  const kept: string[] = []
  for (const entry of described) {
    if (kept.length > 0 && [...kept, entry].join(', ').length > MAX_SELF_TREE_KILLS_DETAIL_LENGTH) {
      break
    }
    kept.push(entry)
  }
  const dropped = described.length - kept.length
  return {
    selfInitiatedTreeKillCount: kills.length,
    selfInitiatedTreeKills: dropped > 0 ? `${kept.join(', ')} (+${dropped} more)` : kept.join(', ')
  }
}

export function resetSelfInitiatedTreeKillLogForTest(): void {
  selfInitiatedKills = []
}
