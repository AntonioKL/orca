/**
 * Per-pane output instrumentation for the devtools typing-latency probe.
 *
 * An input signal stamps t0, xterm's onData marks PTY dispatch,
 * onWriteParsed marks the first subsequent output parse, and onRender marks
 * paint. Overlapping inputs are one ambiguous burst because terminal output is
 * opaque; the probe never apportions one output batch across those inputs.
 */
import { getUtf8ByteLength } from '../../../../shared/utf8-byte-limits'
import {
  createEchoObservation,
  type EchoBatch,
  type EchoCandidate,
  type EchoObservation as EchoObservationValue
} from './echo-observation'
import type { TypingInputSource } from './input-events'
import type { ProbePane } from './pane-target'

export type {
  AmbiguousEchoBurst,
  EchoObservation,
  EchoSourceCounts,
  ExactEchoSample
} from './echo-observation'
export {
  findPaneOwningFocus,
  findPaneOwningNode,
  listProbePanes,
  paneRootElement
} from './pane-target'
export type { ProbePane } from './pane-target'

type Disposable = { dispose: () => void }

export type KeystrokeSource = TypingInputSource

export type PreventedKeystrokeDiscard = 'pending' | 'counted-unmatched' | null

type PendingKeystroke = EchoCandidate

type IgnoredDispatch = {
  t0: number
  source: KeystrokeSource
}

export type InstrumentedPane = {
  pane: ProbePane | null
  undispatched: PendingKeystroke[]
  nextDispatch: PendingKeystroke | null
  deferredNextDispatch: PendingKeystroke | null
  ignoredDispatches: number
  lastIgnoredDispatch: IgnoredDispatch | null
  awaitingEcho: PendingKeystroke[]
  attributionGap: boolean
  parsingBatch: EchoBatch | null
  parsedBatches: EchoBatch[]
  pendingCount: number
  disposables: Disposable[]
  restoreWrite: (() => void) | null
}

/** An input with no output write in this window is unmatched, never an exact sample. */
const ECHO_TIMEOUT_MS = 2000
const MAX_PENDING = 64

function clearDispatchSelection(entry: InstrumentedPane, pending: PendingKeystroke): void {
  if (entry.nextDispatch === pending) {
    entry.nextDispatch = null
  }
  if (entry.deferredNextDispatch === pending) {
    entry.deferredNextDispatch = null
  }
}

function restoreDeferredDispatch(entry: InstrumentedPane): void {
  const deferred = entry.deferredNextDispatch
  entry.deferredNextDispatch = null
  if (deferred && entry.undispatched.includes(deferred)) {
    entry.nextDispatch = deferred
  }
}

function removeOldestTimedOut(entry: InstrumentedPane, now: number): boolean {
  const undispatched = entry.undispatched[0]
  const awaitingEcho = entry.awaitingEcho[0]
  const oldest =
    !undispatched || (awaitingEcho && awaitingEcho.t0 < undispatched.t0)
      ? awaitingEcho
      : undispatched
  if (!oldest || now - oldest.t0 <= ECHO_TIMEOUT_MS) {
    return false
  }
  if (oldest === awaitingEcho) {
    entry.awaitingEcho.shift()
    entry.attributionGap = true
  } else {
    entry.undispatched.shift()
    clearDispatchSelection(entry, oldest)
  }
  entry.pendingCount -= 1
  return true
}

/** Returns how many inputs were dropped without a painted output observation. */
export function recordKeystroke(
  entry: InstrumentedPane,
  now: number,
  source: KeystrokeSource,
  text: string = ''
): number {
  let dropped = 0
  while (removeOldestTimedOut(entry, now)) {
    dropped += 1
  }
  if (entry.pendingCount >= MAX_PENDING) {
    if (entry.ignoredDispatches === 0) {
      entry.deferredNextDispatch = entry.nextDispatch
    }
    entry.nextDispatch = null
    entry.ignoredDispatches += 1
    entry.lastIgnoredDispatch = { t0: now, source }
    return dropped + 1
  }
  const pending = { t0: now, source, text, dispatchedAt: null }
  entry.undispatched.push(pending)
  entry.nextDispatch = pending
  entry.pendingCount += 1
  return dropped
}

/** Removes a prevented routed commit only if it never reached terminal.onData. */
export function discardUndispatchedKeystroke(
  entry: InstrumentedPane,
  recordedAt: number,
  source: KeystrokeSource
): PreventedKeystrokeDiscard {
  const ignored = entry.lastIgnoredDispatch
  if (ignored?.t0 === recordedAt && ignored.source === source) {
    entry.ignoredDispatches = Math.max(0, entry.ignoredDispatches - 1)
    entry.lastIgnoredDispatch = null
    if (entry.ignoredDispatches === 0) {
      restoreDeferredDispatch(entry)
    }
    return 'counted-unmatched'
  }
  for (let index = entry.undispatched.length - 1; index >= 0; index -= 1) {
    const pending = entry.undispatched[index]
    if (!pending || pending.t0 !== recordedAt || pending.source !== source) {
      continue
    }
    entry.undispatched.splice(index, 1)
    clearDispatchSelection(entry, pending)
    entry.nextDispatch ??= entry.undispatched.at(-1) ?? null
    entry.pendingCount -= 1
    return 'pending'
  }
  return null
}

function updateEchoBatch(entry: InstrumentedPane): EchoBatch | null {
  if (!entry.parsingBatch && entry.awaitingEcho.length === 0 && !entry.attributionGap) {
    return null
  }
  const batch = entry.parsingBatch ?? {
    candidates: [],
    hasAttributionGap: false,
    outputBytes: 0,
    outputWrites: 0,
    parsedAt: null
  }
  if (entry.awaitingEcho.length > 0) {
    batch.candidates.push(...entry.awaitingEcho)
    entry.awaitingEcho = []
  }
  if (entry.attributionGap) {
    batch.hasAttributionGap = true
    entry.attributionGap = false
  }
  entry.parsingBatch = batch
  return batch
}

export function instrumentPaneEcho(
  pane: ProbePane,
  onObservation: (observation: EchoObservationValue) => void
): InstrumentedPane {
  const entry: InstrumentedPane = {
    pane,
    undispatched: [],
    nextDispatch: null,
    deferredNextDispatch: null,
    ignoredDispatches: 0,
    lastIgnoredDispatch: null,
    awaitingEcho: [],
    attributionGap: false,
    parsingBatch: null,
    parsedBatches: [],
    pendingCount: 0,
    disposables: [],
    restoreWrite: null
  }
  const terminal = pane.terminal
  if (!terminal) {
    return entry
  }

  const originalWrite = terminal.write
  if (typeof originalWrite === 'function') {
    const wrapped = (data: string | Uint8Array, callback?: () => void): void => {
      const batch = updateEchoBatch(entry)
      if (batch) {
        batch.outputBytes += typeof data === 'string' ? getUtf8ByteLength(data) : data.byteLength
        batch.outputWrites += 1
      }
      originalWrite.call(terminal, data, callback)
    }
    terminal.write = wrapped
    entry.restoreWrite = () => {
      if (terminal.write === wrapped) {
        terminal.write = originalWrite
      }
    }
  }

  if (typeof terminal.onData === 'function') {
    entry.disposables.push(
      terminal.onData(() => {
        let pending = entry.nextDispatch
        if (pending && entry.undispatched.at(-1) === pending) {
          entry.undispatched.pop()
          entry.nextDispatch = null
        } else if (!pending && entry.ignoredDispatches > 0) {
          entry.ignoredDispatches -= 1
          entry.lastIgnoredDispatch = null
          entry.attributionGap = true
          if (entry.ignoredDispatches === 0) {
            restoreDeferredDispatch(entry)
          }
          return
        } else {
          pending = entry.undispatched.shift() ?? null
          entry.nextDispatch = null
        }
        if (!pending) {
          return
        }
        pending.dispatchedAt = performance.now()
        entry.awaitingEcho.push(pending)
      })
    )
  }
  if (typeof terminal.onWriteParsed === 'function') {
    entry.disposables.push(
      terminal.onWriteParsed(() => {
        const batch = entry.parsingBatch
        if (batch) {
          batch.parsedAt = performance.now()
          if (batch.candidates.length > 0) {
            entry.parsedBatches.push(batch)
          }
          entry.parsingBatch = null
        }
      })
    )
  }
  if (typeof terminal.onRender === 'function') {
    entry.disposables.push(
      terminal.onRender(() => {
        const paintedAt = performance.now()
        const batches = entry.parsedBatches
        entry.parsedBatches = []
        for (const batch of batches) {
          entry.pendingCount -= batch.candidates.length
          const observation = createEchoObservation(batch, paintedAt)
          if (observation) {
            onObservation(observation)
          }
        }
      })
    )
  }
  return entry
}

/** Returns trailing inputs that never reached a painted output observation. */
export function detachPaneEcho(entry: InstrumentedPane): number {
  const unmatched = entry.pendingCount
  for (const disposable of entry.disposables) {
    try {
      disposable.dispose()
    } catch {
      // Why: a pane disposed mid-run already dropped its listeners.
    }
  }
  entry.disposables = []
  entry.restoreWrite?.()
  entry.restoreWrite = null
  entry.pane = null
  entry.undispatched = []
  entry.nextDispatch = null
  entry.deferredNextDispatch = null
  entry.ignoredDispatches = 0
  entry.lastIgnoredDispatch = null
  entry.awaitingEcho = []
  entry.attributionGap = false
  entry.parsingBatch = null
  entry.parsedBatches = []
  entry.pendingCount = 0
  return unmatched
}
