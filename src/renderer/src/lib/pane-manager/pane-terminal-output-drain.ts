import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import {
  recordTerminalOutputQueueDebugPressure as recordQueueDebugPressure,
  terminalOutputSchedulerDebugEnabled as debugEnabled,
  terminalOutputSchedulerDebugState as debugState
} from './pane-terminal-output-scheduler-debug'
import {
  clearForegroundHoldSafety,
  clearForegroundRelease,
  isEntryDrainable
} from './pane-terminal-foreground-queue-state'
import {
  ALWAYS_REFRESH_FOREGROUND_SYNCHRONOUSLY,
  BACKGROUND_BACKLOG_WARNING,
  BACKGROUND_DRAIN_INTERVAL_MS,
  DRAIN_TIME_BUDGET_MS,
  FOREGROUND_BACKLOG_WARNING,
  HIGH_PRIORITY_DRAIN_INTERVAL_MS,
  HIGH_PRIORITY_MAX_WRITES_PER_DRAIN,
  LARGE_BACKLOG_CHARS,
  MAX_BACKGROUND_QUEUE_CHUNKS,
  MAX_WRITES_PER_DRAIN,
  getTerminalOutputMaxQueueChars,
  isMessageChannelDrainEnabled,
  markTerminalOutputDrainStarted,
  queuedByTerminal,
  scheduleDrain,
  type QueueEntry,
  type TerminalOutputBeforeWrite
} from './pane-terminal-output-scheduler'

import { writeQueuedChunk } from './pane-terminal-output-pipeline'
// Why: every discard path MUST fire these before clearing/replacing the queue — a dropped chunk still counts as consumed, or main's in-flight window shrinks permanently and the PTY wedges.
export function fireQueuedAckCredits(entry: QueueEntry): void {
  for (let index = entry.chunkIndex; index < entry.chunks.length; index += 1) {
    entry.chunks[index].ackCredit?.()
  }
}

export function discardDetachedQueueEntry(entry: QueueEntry): void {
  fireQueuedAckCredits(entry)
  entry.chunks.length = 0
  entry.chunkIndex = 0
  entry.queuedChars = 0
  entry.highPriority = false
  clearForegroundRelease(entry)
}

export function queueCapExceeded(entry: QueueEntry): boolean {
  return (
    entry.queuedChars > getTerminalOutputMaxQueueChars() ||
    entry.chunks.length - entry.chunkIndex > MAX_BACKGROUND_QUEUE_CHUNKS
  )
}

export function replaceBacklogWithWarning(
  entry: QueueEntry,
  warning: string = BACKGROUND_BACKLOG_WARNING
): void {
  const shouldNotify = !entry.backgroundBacklogDropped
  if (shouldNotify) {
    // Why: field visibility for cap tuning — drop frequency and size decide whether the cap is too small (issue #2836 / #7017).
    recordRendererCrashBreadcrumb('terminal_output_backlog_dropped', {
      foreground: warning === FOREGROUND_BACKLOG_WARNING,
      droppedChars: entry.queuedChars,
      capChars: getTerminalOutputMaxQueueChars()
    })
  }
  let beforeWrite: TerminalOutputBeforeWrite | undefined
  for (let index = entry.chunks.length - 1; index >= entry.chunkIndex; index--) {
    if (entry.chunks[index]?.beforeWrite) {
      beforeWrite = entry.chunks[index].beforeWrite
      break
    }
  }
  clearForegroundHoldSafety(entry)
  fireQueuedAckCredits(entry)
  entry.chunks = [
    {
      data: warning,
      retainedChars: warning.length,
      foreground: false,
      forceForegroundRefresh: false,
      followupForegroundRefresh: false,
      shouldRefreshForegroundSynchronously: ALWAYS_REFRESH_FOREGROUND_SYNCHRONOUSLY,
      stripTransientCursorShows: false,
      beforeWrite
    }
  ]
  entry.chunkIndex = 0
  entry.queuedChars = warning.length
  entry.backgroundBacklogDropped = true
  entry.highPriority = true
  entry.foregroundHold = false
  if (debugEnabled && shouldNotify) {
    debugState.droppedBacklogCount++
  }
  clearForegroundRelease(entry)
  recordQueueDebugPressure()
  if (shouldNotify) {
    entry.onBackgroundBacklogDropped?.()
  }
}

export function hasQueuedChunks(entry: QueueEntry): boolean {
  return entry.chunkIndex < entry.chunks.length
}

export function hasHighPriorityBacklog(): boolean {
  for (const entry of queuedByTerminal.values()) {
    if (
      isEntryDrainable(entry) &&
      (entry.highPriority || entry.queuedChars > LARGE_BACKLOG_CHARS)
    ) {
      return true
    }
  }
  return false
}

function hasDrainableBacklog(): boolean {
  for (const entry of queuedByTerminal.values()) {
    if (isEntryDrainable(entry)) {
      return true
    }
  }
  return false
}

// Why no per-write scroll enforcement: xterm's BufferService.isUserScrolling owns live follow/pin; app-side enforcement is limited to structural ops xterm can't identify, like replay.

function takeNextDrainableEntry(): QueueEntry | null {
  let largeBacklogEntry: QueueEntry | null = null
  for (const entry of queuedByTerminal.values()) {
    if (!isEntryDrainable(entry)) {
      continue
    }
    // Why: active/foreground output should be chosen first, not left in insertion order behind older background terminals.
    if (entry.highPriority) {
      queuedByTerminal.delete(entry.terminal)
      return entry
    }
    if (!largeBacklogEntry && entry.queuedChars > LARGE_BACKLOG_CHARS) {
      largeBacklogEntry = entry
    }
  }
  if (largeBacklogEntry) {
    queuedByTerminal.delete(largeBacklogEntry.terminal)
    return largeBacklogEntry
  }
  for (const entry of queuedByTerminal.values()) {
    if (!isEntryDrainable(entry)) {
      continue
    }
    queuedByTerminal.delete(entry.terminal)
    return entry
  }
  return null
}

// Why: re-arm a zero-delay drain once xterm confirms the previous high-priority batch parsed; the fixed 4/16ms cadence otherwise drips far below xterm's ~100 MB/s parse. Only visible panes are pacer-clocked; background keeps the fixed cadence to protect the focused terminal.

function getDrainNow(): number {
  if (typeof performance !== 'undefined') {
    return performance.now()
  }
  return Date.now()
}

export function drainQueuedOutputImpl(): void {
  markTerminalOutputDrainStarted()
  let writes = 0
  const startedAt = getDrainNow()
  const highPriority = hasHighPriorityBacklog()
  const maxWrites = highPriority ? HIGH_PRIORITY_MAX_WRITES_PER_DRAIN : MAX_WRITES_PER_DRAIN

  while (queuedByTerminal.size > 0 && writes < maxWrites) {
    const entry = takeNextDrainableEntry()
    if (!entry) {
      break
    }

    const writeKind = writeQueuedChunk(entry)
    if (writeKind) {
      writes++
      if (debugEnabled) {
        if (writeKind === 'foreground') {
          debugState.deferredForegroundWriteCount++
        } else {
          debugState.backgroundWriteCount++
        }
      }
    }
    if (hasQueuedChunks(entry)) {
      queuedByTerminal.set(entry.terminal, entry)
    } else {
      entry.highPriority = false
      clearForegroundRelease(entry)
    }
    // Why: xterm parsing and DOM work share the renderer thread with input; keep draining cooperative so WSL/agent output can't pin the UI.
    if (writes > 0 && getDrainNow() - startedAt >= DRAIN_TIME_BUDGET_MS) {
      break
    }
  }

  if (debugEnabled && writes > 0) {
    debugState.drainWrites.push(writes)
    debugState.drainHighPriority.push(highPriority)
  }
  recordQueueDebugPressure()
  if (queuedByTerminal.size > 0 && hasDrainableBacklog()) {
    // Why 0 on the channel path: a posted message already yields (input/paint serviced between macrotasks), so the 4ms interval only deepened the queue; timer path keeps it for fake-timer tests.
    scheduleDrain(
      hasHighPriorityBacklog()
        ? isMessageChannelDrainEnabled()
          ? 0
          : HIGH_PRIORITY_DRAIN_INTERVAL_MS
        : BACKGROUND_DRAIN_INTERVAL_MS
    )
  }
}
