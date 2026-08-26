import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import type { GpuFallbackEnvironment, WindowsGpuFallbackEnvironment } from './gpu-fallback-marker'
import { readPersistedJson, type PersistedJsonRead } from './persisted-json-read'

/**
 * Persisted GPU-crash evidence, sibling of gpu-fallback.json.
 *
 * Why a second file: that one is the *decision*, this is the *evidence* for it — merging them
 * would make version-invalidation mean two things at once. Needed at all because crash-at-
 * startup kills the process ~600ms in, so GpuCrashFallbackTracker never reaches its threshold
 * and the marker was structurally unwritable: every launch crashed exactly once and forgot.
 */

export const GPU_CRASH_HISTORY_FILE = 'gpu-crash-history.json'
export const GPU_CRASH_HISTORY_SCHEME_VERSION = 1

/** Distinct launches retained; one entry per launch, so the file stays a fixed small size. */
export const GPU_CRASH_HISTORY_MAX_ENTRIES = 8
/** Wall-clock horizon: crashes older than this are not evidence about today's driver. */
export const GPU_CRASH_HISTORY_HORIZON_MS = 600_000
/** Only crashes this early in a launch mean "cannot even boot". */
export const GPU_CRASH_STARTUP_WINDOW_MS = 15_000
/** Distinct crashing launches inside the horizon that engage software rendering. */
export const CROSS_LAUNCH_GPU_FALLBACK_THRESHOLD = 3
/**
 * Threshold once a *previous* build already fell back: that build's evidence is
 * gone with the update, so the full threshold would cost a chronically broken
 * machine three unbootable launches per release. One fresh hardware attempt is
 * kept — the update may be the fix — and the second startup crash re-engages.
 */
export const CROSS_LAUNCH_GPU_FALLBACK_THRESHOLD_AFTER_UPDATE = 1

export type GpuCrashHistoryEntry = {
  atEpochMs: number
  msSinceLaunch: number
  launchId: string
}

type GpuCrashHistory = {
  schemeVersion: number
  appVersion: string
  electronVersion: string
  platform: 'win32'
  crashes: GpuCrashHistoryEntry[]
}

function historyPath(userDataPath: string): string {
  return join(userDataPath, GPU_CRASH_HISTORY_FILE)
}

function parseEntry(value: unknown): GpuCrashHistoryEntry | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const entry = value as Partial<Record<keyof GpuCrashHistoryEntry, unknown>>
  if (
    typeof entry.atEpochMs !== 'number' ||
    !Number.isFinite(entry.atEpochMs) ||
    typeof entry.msSinceLaunch !== 'number' ||
    !Number.isFinite(entry.msSinceLaunch) ||
    entry.msSinceLaunch < 0 ||
    typeof entry.launchId !== 'string' ||
    entry.launchId.length === 0
  ) {
    return null
  }
  return {
    atEpochMs: entry.atEpochMs,
    msSinceLaunch: entry.msSinceLaunch,
    launchId: entry.launchId
  }
}

function parseHistory(value: unknown): GpuCrashHistory | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const parsed = value as Partial<Record<keyof GpuCrashHistory, unknown>>
  if (parsed.schemeVersion !== GPU_CRASH_HISTORY_SCHEME_VERSION) {
    return null
  }
  if (
    typeof parsed.appVersion !== 'string' ||
    typeof parsed.electronVersion !== 'string' ||
    parsed.platform !== 'win32' ||
    !Array.isArray(parsed.crashes)
  ) {
    return null
  }
  return {
    schemeVersion: GPU_CRASH_HISTORY_SCHEME_VERSION,
    appVersion: parsed.appVersion,
    electronVersion: parsed.electronVersion,
    platform: parsed.platform,
    // Why: capped before parsing, not just on write. This runs before whenReady, and only
    // the newest entries can still be inside the horizon, so a file grown by anything other
    // than this code costs the launch path a bounded parse instead of one linear in its size.
    // Dropping an unreadable entry keeps the rest: a truncated write is still evidence.
    crashes: parsed.crashes
      .slice(-GPU_CRASH_HISTORY_MAX_ENTRIES)
      .map(parseEntry)
      .filter((entry): entry is GpuCrashHistoryEntry => entry !== null)
  }
}

function readGpuCrashHistory(userDataPath: string): PersistedJsonRead<GpuCrashHistory> {
  return readPersistedJson(historyPath(userDataPath), parseHistory)
}

/**
 * Whole-file drop, only for events that retire the evidence outright: promoted into the marker,
 * or Safe Graphics Mode set by hand. Per-launch steps use forgetGpuCrashLaunch — one launch is
 * never entitled to speak for the launches it did not live through.
 */
export function clearGpuCrashHistory(userDataPath: string): void {
  try {
    rmSync(historyPath(userDataPath), { force: true })
  } catch {
    // best effort; stale evidence ages out of the horizon anyway
  }
}

/**
 * Crash history recorded by this exact build, or an empty list. Evidence from another
 * app/Electron build says nothing about this one, so it is discarded, not carried forward.
 */
export function readActiveGpuCrashHistory(
  userDataPath: string,
  environment: GpuFallbackEnvironment
): readonly GpuCrashHistoryEntry[] {
  return loadActiveGpuCrashHistory(userDataPath, environment).crashes
}

/** Plus "nothing recorded" vs "could not read it" — a distinction only the write path needs. */
function loadActiveGpuCrashHistory(
  userDataPath: string,
  environment: GpuFallbackEnvironment
): { crashes: readonly GpuCrashHistoryEntry[]; unreadable: boolean } {
  const read = readGpuCrashHistory(userDataPath)
  if (read.kind !== 'ok') {
    // Why: delete only what parsed as not-ours. A file this process merely could not open —
    // a Defender sharing violation right after the publishing rename is the Windows shape —
    // is still every earlier launch's evidence, and it ages out of the horizon by itself.
    if (read.kind === 'invalid') {
      clearGpuCrashHistory(userDataPath)
    }
    return { crashes: [], unreadable: read.kind === 'unreadable' }
  }
  const history = read.value
  if (
    environment.platform !== 'win32' ||
    history.platform !== environment.platform ||
    history.appVersion !== environment.appVersion ||
    history.electronVersion !== environment.electronVersion
  ) {
    clearGpuCrashHistory(userDataPath)
    return { crashes: [], unreadable: false }
  }
  return { crashes: history.crashes, unreadable: false }
}

/**
 * Durable (fsync + rename) because the caller is a process Chromium may FATAL
 * milliseconds later: a torn or zero-length file destroys every earlier launch's
 * evidence, not just this entry. writeFileDurableSync removes its own temp on
 * every path that does not commit; sweepOrphanedGpuFallbackWrites reclaims the
 * ones a FATAL mid-write leaves behind.
 */
function writeGpuCrashHistory(userDataPath: string, history: GpuCrashHistory): void {
  const target = historyPath(userDataPath)
  writeFileDurableSync(durableWriteTempPath(target), target, JSON.stringify(history))
}

/**
 * Records one crashing launch. The read-time filters are enforced here too, so an uncountable
 * crash can never take a slot: a driver in a respawn loop emits dozens under one launchId, and
 * appending them all would evict every other launch and pin the distinct-launch count at 1.
 */
export function recordGpuCrashInHistory(
  userDataPath: string,
  entry: GpuCrashHistoryEntry,
  environment: WindowsGpuFallbackEnvironment
): void {
  if (entry.msSinceLaunch > GPU_CRASH_STARTUP_WINDOW_MS) {
    return
  }
  const existing = loadActiveGpuCrashHistory(userDataPath, environment)
  // Why: publishing a one-entry file over a history we failed to read would erase the other
  // launches just as surely as deleting it. One launch's entry is the cheaper thing to lose.
  if (existing.unreadable || existing.crashes.some((crash) => crash.launchId === entry.launchId)) {
    return
  }
  writeGpuCrashHistory(userDataPath, {
    schemeVersion: GPU_CRASH_HISTORY_SCHEME_VERSION,
    appVersion: environment.appVersion,
    electronVersion: environment.electronVersion,
    platform: 'win32',
    crashes: [...existing.crashes, entry].slice(-GPU_CRASH_HISTORY_MAX_ENTRIES)
  })
}

/**
 * Drops one launch's evidence and keeps every other launch's. A launch answers only for itself:
 * it painted a window and survived, or the user declined the prompt it raised — neither says
 * anything about the earlier launches that died before any window existed.
 */
export function forgetGpuCrashLaunch(userDataPath: string, launchId: string): void {
  const read = readGpuCrashHistory(userDataPath)
  if (read.kind !== 'ok') {
    return
  }
  const history = read.value
  const crashes = history.crashes.filter((crash) => crash.launchId !== launchId)
  if (crashes.length === history.crashes.length) {
    return
  }
  if (crashes.length === 0) {
    clearGpuCrashHistory(userDataPath)
    return
  }
  writeGpuCrashHistory(userDataPath, { ...history, crashes })
}

/**
 * Distinct launches whose GPU child died during startup inside the horizon. Both filters
 * matter: without the horizon a healthy machine accumulates a false positive over months, and
 * without the startup window a mid-session crash feeds a counter meaning "cannot even boot".
 */
export function countStartupGpuCrashLaunches(
  crashes: readonly GpuCrashHistoryEntry[],
  nowEpochMs: number
): number {
  const launchIds = new Set<string>()
  for (const crash of crashes) {
    // Why absolute: atEpochMs is stamped ~600ms into boot, before W32Time corrects a
    // wrong RTC, so a later backward correction leaves future-dated entries that a
    // one-directional horizon would never age out — evidence immortal for the build.
    if (Math.abs(nowEpochMs - crash.atEpochMs) > GPU_CRASH_HISTORY_HORIZON_MS) {
      continue
    }
    if (crash.msSinceLaunch > GPU_CRASH_STARTUP_WINDOW_MS) {
      continue
    }
    launchIds.add(crash.launchId)
  }
  return launchIds.size
}
