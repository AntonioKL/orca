/**
 * Per-pane output instrumentation for the devtools typing-latency probe.
 *
 * An input signal stamps t0, xterm's onData marks PTY dispatch,
 * onWriteParsed marks the first subsequent output parse, and onRender marks
 * paint. Overlapping inputs are one ambiguous burst because terminal output is
 * opaque; the probe never apportions one output batch across those inputs.
 */
import { getUtf8ByteLength } from '../../../../shared/utf8-byte-limits'
import { subscribeToTerminalUserInput } from '@/components/terminal-pane/terminal-user-input-signal'
import type { Terminal } from '@xterm/xterm'
import { clearEchoDispatchSelection, drainTimedOutEchoCandidates } from './echo-candidate-timeout'
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
export { drainTimedOutEchoCandidates }

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
  ignoredDispatchIdentities: IgnoredDispatch[]
  awaitingEcho: PendingKeystroke[]
  attributionGap: boolean
  parsingBatch: EchoBatch | null
  parsedBatches: EchoBatch[]
  pendingCount: number
  disposables: Disposable[]
  restoreWrite: (() => void) | null
}

const MAX_PENDING = 64

function restoreDeferredDispatch(entry: InstrumentedPane): void {
  const deferred = entry.deferredNextDispatch
  entry.deferredNextDispatch = null
  if (deferred && entry.undispatched.includes(deferred)) {
    entry.nextDispatch = deferred
  }
}

/** Returns how many inputs were dropped without a painted output observation. */
export function recordKeystroke(
  entry: InstrumentedPane,
  now: number,
  source: KeystrokeSource,
  text: string = ''
): number {
  const dropped = drainTimedOutEchoCandidates(entry, now)
  if (entry.pendingCount >= MAX_PENDING) {
    if (entry.ignoredDispatches === 0) {
      entry.deferredNextDispatch = entry.nextDispatch
    }
    entry.nextDispatch = null
    entry.ignoredDispatches += 1
    entry.ignoredDispatchIdentities.push({ t0: now, source })
    if (entry.ignoredDispatchIdentities.length > MAX_PENDING) {
      entry.ignoredDispatchIdentities.shift()
    }
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
  for (let index = entry.ignoredDispatchIdentities.length - 1; index >= 0; index -= 1) {
    const ignored = entry.ignoredDispatchIdentities[index]
    if (!ignored || ignored.t0 !== recordedAt || ignored.source !== source) {
      continue
    }
    entry.ignoredDispatchIdentities.splice(index, 1)
    entry.ignoredDispatches -= 1
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
    clearEchoDispatchSelection(entry, pending)
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
    ignoredDispatchIdentities: [],
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

  let pendingUserInputSignals = 0
  const userInputDisposable = subscribeToTerminalUserInput(terminal as Terminal, () => {
    pendingUserInputSignals = Math.min(MAX_PENDING, pendingUserInputSignals + 1)
  })
  if (userInputDisposable) {
    entry.disposables.push(userInputDisposable)
  }

  if (typeof terminal.onData === 'function') {
    entry.disposables.push(
      terminal.onData(() => {
        if (userInputDisposable) {
          if (pendingUserInputSignals === 0) {
            return
          }
          pendingUserInputSignals -= 1
        }
        let pending = entry.nextDispatch
        if (pending && entry.undispatched.at(-1) === pending) {
          entry.undispatched.pop()
          entry.nextDispatch = null
        } else if (!pending && entry.ignoredDispatches > 0) {
          entry.ignoredDispatches -= 1
          entry.ignoredDispatchIdentities.pop()
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
  entry.ignoredDispatchIdentities = []
  entry.awaitingEcho = []
  entry.attributionGap = false
  entry.parsingBatch = null
  entry.parsedBatches = []
  entry.pendingCount = 0
  return unmatched
}
