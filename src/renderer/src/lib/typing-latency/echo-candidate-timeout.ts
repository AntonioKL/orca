import type { InstrumentedPane } from './echo-instrumentation'
import type { EchoCandidate } from './echo-observation'

const ECHO_TIMEOUT_MS = 2000

export function clearEchoDispatchSelection(
  entry: InstrumentedPane,
  candidate: EchoCandidate
): void {
  if (entry.nextDispatch === candidate) {
    entry.nextDispatch = null
  }
  if (entry.deferredNextDispatch === candidate) {
    entry.deferredNextDispatch = null
  }
}

function drainTimedOutCandidates(
  candidates: EchoCandidate[],
  now: number,
  onDrop?: (candidate: EchoCandidate) => void
): number {
  let retained = 0
  let dropped = 0
  for (const candidate of candidates) {
    if (now - candidate.t0 > ECHO_TIMEOUT_MS) {
      dropped += 1
      onDrop?.(candidate)
    } else {
      candidates[retained] = candidate
      retained += 1
    }
  }
  candidates.length = retained
  return dropped
}

/** Removes inputs whose echo window elapsed and returns the unmatched count. */
export function drainTimedOutEchoCandidates(entry: InstrumentedPane, now: number): number {
  let dropped = drainTimedOutCandidates(entry.undispatched, now, (candidate) =>
    clearEchoDispatchSelection(entry, candidate)
  )
  const awaitingEchoDropped = drainTimedOutCandidates(entry.awaitingEcho, now)
  if (awaitingEchoDropped > 0) {
    entry.attributionGap = true
    dropped += awaitingEchoDropped
  }
  if (entry.parsingBatch) {
    const parsingDropped = drainTimedOutCandidates(entry.parsingBatch.candidates, now)
    if (parsingDropped > 0) {
      entry.parsingBatch.hasAttributionGap = true
      dropped += parsingDropped
    }
  }
  for (const batch of entry.parsedBatches) {
    const parsedDropped = drainTimedOutCandidates(batch.candidates, now)
    if (parsedDropped > 0) {
      batch.hasAttributionGap = true
      dropped += parsedDropped
    }
  }
  if (dropped > 0) {
    entry.pendingCount -= dropped
    entry.parsedBatches = entry.parsedBatches.filter((batch) => batch.candidates.length > 0)
  }
  return dropped
}
