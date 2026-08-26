// Type-only, so this erases at compile time and creates no import cycle.
import type { CrashReportDetailValue } from './crash-reporting'

/**
 * Promotes the Crashpad-derived fields out of the details blob.
 *
 * Why: for a Chromium CHECK the exit code is only 0x80000003 (STATUS_BREAKPOINT),
 * so the fatal log line is the actual diagnosis and must not be buried in a
 * detail list the reader scrolls past.
 */
export function appendMinidumpSignatureLines(
  lines: string[],
  details: Record<string, CrashReportDetailValue>
): void {
  // Why: an unread annotation list left `ptype` unread too, so nothing lifted out
  // of the dump is confirmed to be this process's — and a fatal line reads as this
  // crash's diagnosis up here while the raw status sits in a detail list read past.
  const unattributed =
    details.minidumpAnnotationListStatus === 'unreadable' &&
    typeof details.minidumpProcessType !== 'string'
  if (typeof details.minidumpCheckMessage === 'string') {
    const doubt = unattributed ? ' (process unconfirmed: annotation list unreadable)' : ''
    lines.push(`Check failure: ${details.minidumpCheckMessage}${doubt}`)
  } else if (unattributed) {
    lines.push('Minidump process: unconfirmed (annotation list unreadable)')
  }
  const status = details.minidumpModuleListStatus
  if (typeof details.minidumpFaultingModule === 'string') {
    const offset = details.minidumpFaultingModuleOffset
    const suffix = typeof offset === 'string' ? `+${offset}` : ''
    // Why beside the name: a name matched out of a list we never finished reads
    // as verified up here, while the status alone sits in a list read past.
    const doubt = typeof status === 'string' ? ` (module list ${status})` : ''
    lines.push(`Faulting module: ${details.minidumpFaultingModule}${suffix}${doubt}`)
    return
  }
  // Why: an unread module list cannot name the module, and silence there reads
  // as "the address belongs to no module" — a claim the parser never made.
  if (typeof status === 'string') {
    lines.push(`Faulting module: unresolved (module list ${status})`)
  }
}
