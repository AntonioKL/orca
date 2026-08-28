import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { salvagePidFromCorruptDaemonRecord } from './daemon-pid-file-parse'
import { inspectProcessLiveness } from './daemon-process-inspection'

/**
 * A pid record that parses to nothing would otherwise veto daemon-host pruning on every future
 * launch: nothing ever rewrites a retired protocol version's pid file, so the veto never expires.
 * Quarantine the record (rename in place, bytes kept for diagnosis) so the next launch scans a
 * complete listing again — unless a process still answers for a pid salvaged from the corrupt
 * bytes, in which case the record may belong to a live daemon and keeps its conservative veto
 * until that pid exits. Returns the unverifiable reason; every branch is logged because this
 * state suppresses pruning.
 */
export function quarantineCorruptDaemonPidRecord(
  runtimeDir: string,
  name: string,
  contents: string
): string {
  const salvagedPid = salvagePidFromCorruptDaemonRecord(contents)
  if (salvagedPid !== null && inspectProcessLiveness(salvagedPid).status !== 'exited') {
    const reason = `the daemon pid file could not be parsed and salvaged pid ${salvagedPid} may still be running: ${name}`
    console.warn(`[daemon] Keeping corrupt daemon pid record: ${reason}`)
    return reason
  }
  try {
    renameSync(join(runtimeDir, name), join(runtimeDir, `${name}.corrupt`))
  } catch {
    const reason = `the daemon pid file could not be parsed or quarantined: ${name}`
    console.warn(`[daemon] ${reason}`)
    return reason
  }
  const reason = `the daemon pid file could not be parsed and was quarantined: ${name}`
  console.warn(`[daemon] ${reason}`)
  return reason
}
