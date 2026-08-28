import { BoundedMap } from '../../shared/bounded-map'

/**
 * Session ids whose exit this adapter's daemon reported.
 *
 * Why a tombstone rather than `!activeSessionIds.has(id)`: bare absence also describes an
 * id this adapter never owned — a session held by another daemon generation, or one whose
 * tracking a lost socket dropped — and that observes nothing. Only ids whose exit event
 * arrived here may answer `exited`; eviction degrades to `unverifiable`.
 */
export class DaemonSessionExitObservations {
  private readonly observedExits = new BoundedMap<string, true>({ maxEntries: 1_024 })

  recordExit(sessionId: string): void {
    this.observedExits.set(sessionId, true)
  }

  /**
   * Why clearing matters: daemon session ids are derived from the pane, so a reopened
   * terminal reuses the id of the one that exited. A certificate that outlived its
   * session would then answer `exited` for a live pane the app merely lost track of.
   */
  clearForLiveSession(sessionId: string): void {
    this.observedExits.delete(sessionId)
  }

  verdict(sessionId: string): 'exited' | 'unverifiable' {
    return this.observedExits.has(sessionId) ? 'exited' : 'unverifiable'
  }
}
