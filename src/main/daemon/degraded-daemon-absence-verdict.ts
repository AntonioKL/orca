import { BoundedMap } from '../../shared/bounded-map'
import type { IPtyProvider } from '../providers/types'

/**
 * What a session id's absence proves in the degraded router.
 *
 * The router forgets a session's route the moment that session exits, and the absence
 * verdict is only ever read after that, so the owner that watched the exit is remembered
 * here rather than inferred from the routing table. Only an owner this router recorded —
 * currently routed, or seen to watch the exit — may answer; an id neither table knows was
 * never observed here, so its absence is a lost route, not a death certificate.
 */
export class DegradedDaemonAbsenceVerdict {
  private readonly watchedExitOwners = new BoundedMap<string, IPtyProvider>({ maxEntries: 1_024 })

  constructor(private readonly routes: ReadonlyMap<string, IPtyProvider>) {}

  /** The provider that emitted the exit is the one that watched it. */
  recordWatchedExit(sessionId: string, owner: IPtyProvider): void {
    this.watchedExitOwners.set(sessionId, owner)
  }

  read(sessionId: string): 'exited' | 'unverifiable' {
    return (
      (this.routes.get(sessionId) ?? this.watchedExitOwners.get(sessionId))?.ptyAbsenceVerdict?.(
        sessionId
      ) ?? 'unverifiable'
    )
  }
}
