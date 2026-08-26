// Type-only, so this erases at compile time and creates no import cycle.
import type { CrashReportDetailValue } from './crash-reporting'

// Wording stays platform-neutral: the image is `Orca.exe` on Windows, `orca` on
// Linux and `Electron Framework` on macOS.
const PRODUCT_IMAGE_NOTE =
  'the Electron image Chromium is statically linked into, so the name does not localize the fault; read the offset and exception code instead'
const UNIDENTIFIED_IMAGE_NOTE =
  'this build could not say which image Chromium is linked into, so the name may not localize the fault'

function resolvedModuleLine(details: Record<string, CrashReportDetailValue>): string | null {
  const module = details.minidumpFaultingModule
  if (typeof module !== 'string') {
    return null
  }
  const offset = details.minidumpFaultingModuleOffset
  const suffix = typeof offset === 'string' ? `+${offset}` : ''
  const identity = details.minidumpFaultingModuleIdentity
  // Older hosts send no identity; leaving those lines unqualified beats guessing.
  const note =
    identity === 'product-image'
      ? PRODUCT_IMAGE_NOTE
      : identity === 'unidentified'
        ? UNIDENTIFIED_IMAGE_NOTE
        : null
  return `Faulting module: ${module}${suffix}${note ? ` (${note})` : ''}`
}

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
  if (typeof details.minidumpCheckMessage === 'string') {
    lines.push(`Check failure: ${details.minidumpCheckMessage}`)
  }
  const resolved = resolvedModuleLine(details)
  if (resolved) {
    lines.push(resolved)
    return
  }
  // Stated, not omitted: silence reads as "no module was involved", which is a
  // claim the dump never made. Old hosts send no state and so still say nothing.
  const state = details.minidumpFaultingModuleState
  if (state !== 'unknown' && state !== 'not-applicable') {
    return
  }
  const reason = details.minidumpFaultingModuleReason
  const why = typeof reason === 'string' ? ` (${reason})` : ''
  lines.push(`Faulting module: ${state === 'unknown' ? 'unknown' : 'not applicable'}${why}`)
}
