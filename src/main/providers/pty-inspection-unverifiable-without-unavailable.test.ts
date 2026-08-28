import { describe, expect, it } from 'vitest'
import { buildDaemonInspectProcessResult } from '../daemon/terminal-host-process-evidence'
import { classifyLocalPtyChildProcesses } from './local-pty-process-evidence'
import type { PtyProcessInspection } from './pty-process-inspection'

/**
 * Reachability pin for the tab-close guard's `unverifiable` arm.
 *
 * The guard lives in the renderer and cannot import these producers across the tsconfig
 * project boundary, so the claim it rests on is pinned here, where they live: a host that
 * was *reached* can publish "could not tell" as `hasChildProcesses: false` with no
 * `unavailable` flag — byte-identical to an observed-idle shell. Per
 * docs/reference/ssh-execution-boundary.md that is `unverifiable`, never exit evidence, and
 * the guard's counterpart cases are in
 * src/renderer/src/components/terminal/running-terminal-close-unverifiable-children.test.ts.
 */
describe('an in-contact PTY probe that could not determine child processes', () => {
  /** Assembles the wire result exactly as LocalPtyProvider.inspectProcess does, field for
   *  field, so the shape asserted here is the one the provider actually publishes. */
  function localInspection(
    foreground: Parameters<typeof classifyLocalPtyChildProcesses>[0]['foreground'],
    titleRead: Parameters<typeof classifyLocalPtyChildProcesses>[0]['titleRead'],
    shell: string | undefined,
    foregroundProcess: string | null
  ): PtyProcessInspection {
    const children = classifyLocalPtyChildProcesses({
      procPresent: true,
      titleRead,
      shell,
      foreground
    })
    return {
      foregroundProcess,
      hasChildProcesses: children.hasChildProcesses,
      processEvidence: { foreground, children: children.evidence }
    }
  }

  // node-pty's POSIX title read silently falls back to the spawned shell name when the
  // native read fails, so under the same distress that degrades the scan "title == shell"
  // observes nothing. This is the load-bearing local shape.
  it('publishes a degraded local scan as unverifiable with no unavailable flag', () => {
    const inspection = localInspection(
      { verdict: 'unverifiable', reason: 'process table scan degraded' },
      { ok: true, title: 'zsh' },
      'zsh',
      'zsh'
    )

    expect(inspection.processEvidence?.children.verdict).toBe('unverifiable')
    expect(inspection.hasChildProcesses).toBe(false)
    expect(inspection).not.toHaveProperty('unavailable')
  })

  it('publishes a failed pty title read the same way', () => {
    const inspection = localInspection(
      { verdict: 'observed', processName: null },
      { ok: false },
      'zsh',
      null
    )

    expect(inspection.processEvidence?.children.verdict).toBe('unverifiable')
    expect(inspection.hasChildProcesses).toBe(false)
    expect(inspection).not.toHaveProperty('unavailable')
  })

  // A daemon pane's only child signal IS its foreground observation, so a foreground read
  // that did not land reaches the same shape from a second, independent producer.
  it('publishes a daemon pane with an unlanded foreground observation the same way', () => {
    const inspection = buildDaemonInspectProcessResult({
      processName: 'zsh',
      evidence: {
        verdict: 'unverifiable',
        reason: 'subprocess handle reports no foreground evidence'
      }
    })

    expect(inspection.processEvidence?.children.verdict).toBe('unverifiable')
    expect(inspection.hasChildProcesses).toBe(false)
    expect(inspection).not.toHaveProperty('unavailable')
  })

  // The collapse itself: a completed scan that positively observed an idle shell publishes
  // legacy fields indistinguishable from all three cases above.
  it('is indistinguishable from an observed idle shell on the legacy fields alone', () => {
    const degraded = localInspection(
      { verdict: 'unverifiable', reason: 'process table scan degraded' },
      { ok: true, title: 'zsh' },
      'zsh',
      'zsh'
    )
    const observed = localInspection(
      { verdict: 'observed', processName: 'zsh' },
      { ok: true, title: 'zsh' },
      'zsh',
      'zsh'
    )

    expect(observed.processEvidence?.children.verdict).toBe('exited')
    expect(degraded.foregroundProcess).toBe(observed.foregroundProcess)
    expect(degraded.hasChildProcesses).toBe(observed.hasChildProcesses)
    expect(degraded.unavailable).toBe(observed.unavailable)
  })

  // The local classifier can also publish `false` beside a positively observed 'live' when
  // a stale shell title would otherwise contradict the completed scan — the collapse
  // pointing the other way, and the reason the guard reads the verdict for `live` too.
  it('publishes an observed live child as a false boolean when the title went stale', () => {
    const inspection = localInspection(
      { verdict: 'observed', processName: 'claude' },
      { ok: true, title: 'zsh' },
      'zsh',
      'claude'
    )

    expect(inspection.processEvidence?.children.verdict).toBe('live')
    expect(inspection.hasChildProcesses).toBe(false)
  })
})
