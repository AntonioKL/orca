import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { readPtyProcessInspectionEvidence } from '../../../../shared/pty-process-inspection-evidence'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'

/**
 * Whether any local PTY must stop the window from closing silently.
 *
 * `exited` is the only verdict that closes with no prompt. A probe that could
 * not answer is `unverifiable` (docs/reference/ssh-execution-boundary.md) and
 * must never read as an idle shell: the degraded local read publishes the
 * legacy collapse — the stable-cache shell name and `hasChildProcesses: false` —
 * which is byte-identical to a genuinely idle pane unless the evidence is read.
 * Unlike every other consumer of this evidence, closing here acts for the user
 * and destroys the work the warning would have let them save, so unknown asks.
 */
export async function anyLocalPtyBlocksWindowClose(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyIds: readonly string[]
): Promise<boolean> {
  const results = await Promise.allSettled(
    ptyIds.map((ptyId) => inspectRuntimeTerminalProcess(settings, ptyId))
  )
  return results.some((result) => {
    // Why rejected counts as blocking: a raised inspection answered nothing, and
    // the Promise.all this replaced had no catch — a rejection left the window
    // neither closed nor prompting.
    if (result.status === 'rejected') {
      return true
    }
    // Why before the evidence read: `unavailable` is the host saying it could not
    // route to this pane at all, and it rides with the legacy idle collapse
    // (null/false) and no evidence — so reading it would fabricate `exited` out
    // of fields nothing observed. `probeTerminalLiveness` fences the same shape
    // on the cleanup path; this one is strictly more destructive.
    if (result.value.unavailable === true) {
      return true
    }
    return readPtyProcessInspectionEvidence(result.value).children.verdict !== 'exited'
  })
}
