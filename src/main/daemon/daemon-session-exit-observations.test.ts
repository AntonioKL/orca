/* The certificate's own contract. `daemon-watched-exit-absence-verdict.test.ts` drives these
 * orderings through a real daemon, but only over a protocol that reports incarnation ids —
 * which is exactly the half where the router's `exitedBeforeSpawnReply` gate is redundant.
 * These cases hold the degraded half, where the id is all anyone has. */
import { describe, expect, it } from 'vitest'
import { DaemonSessionExitObservations } from './daemon-session-exit-observations'

const SESSION = 'wt-1::/repo@@abc'

describe('a watched-exit certificate', () => {
  it('answers only for ids whose exit arrived here', () => {
    const observations = new DaemonSessionExitObservations()
    observations.recordExit(SESSION, 'inc-1')

    expect(observations.verdict(SESSION)).toBe('exited')
    expect(observations.verdict('never-watched')).toBe('unverifiable')
  })

  it('survives a live marker for the very incarnation that issued it', () => {
    // The spawn-finalization ordering: the exit is certified while its own spawn is still
    // completing, so the retirement that follows names the incarnation that just died.
    const observations = new DaemonSessionExitObservations()
    observations.recordExit(SESSION, 'inc-1')

    observations.clearForLiveSession(SESSION, 'inc-1')

    expect(observations.verdict(SESSION)).toBe('exited')
  })

  it('is retired by a live marker for a different run of the same pane', () => {
    const observations = new DaemonSessionExitObservations()
    observations.recordExit(SESSION, 'inc-1')

    observations.clearForLiveSession(SESSION, 'inc-2')

    expect(observations.verdict(SESSION)).toBe('unverifiable')
  })

  it('refuses an exit that arrives after a later incarnation went live', () => {
    // The late-event ordering: a delete cannot reach an exit that has not landed yet, so the
    // live marker has to stand and turn the late one away.
    const observations = new DaemonSessionExitObservations()
    observations.clearForLiveSession(SESSION, 'inc-2')

    observations.recordExit(SESSION, 'inc-1')

    expect(observations.verdict(SESSION)).toBe('unverifiable')
  })

  /** A daemon too old to report incarnations leaves both sides unidentified. Nothing can be
   *  told apart then, so clearing retires unconditionally — which is why the router still
   *  withholds the retirement entirely for an exit that beat its own spawn reply. */
  it('retires unconditionally when no incarnation is reported', () => {
    const observations = new DaemonSessionExitObservations()
    observations.recordExit(SESSION)
    expect(observations.verdict(SESSION)).toBe('exited')

    observations.clearForLiveSession(SESSION)

    expect(observations.verdict(SESSION)).toBe('unverifiable')
  })

  it('still records an unidentified exit after an identified session went live', () => {
    // Degrading must not invent proof, but it must not silently drop it either: with no
    // incarnation on the event there is nothing to contradict, so the exit stands.
    const observations = new DaemonSessionExitObservations()
    observations.clearForLiveSession(SESSION, 'inc-2')

    observations.recordExit(SESSION)

    expect(observations.verdict(SESSION)).toBe('exited')
  })
})
