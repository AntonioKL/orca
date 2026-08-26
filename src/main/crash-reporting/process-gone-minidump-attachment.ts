import { sanitizeCrashReportDetails } from '../../shared/crash-reporting'
import type { CrashReportStore } from './crash-report-store'
import { captureMinidumpSignature, type CapturedMinidump } from './crashpad-capture'
import { minidumpSignatureDetails } from './minidump-crash-signature'
import type { ProcessGoneSource } from './process-gone-classification'
import { flushActiveSink, startSpan } from '../observability/tracer'

type MinidumpDetailStore = Pick<CrashReportStore, 'attachDetails'>

/** Injectable so tests can drive the pairing without a Crashpad handler. */
export type MinidumpCapture = (
  crashedAtMs: number,
  expectedProcessType: string
) => Promise<CapturedMinidump | null>

const CHILD_CRASHPAD_PROCESS_TYPES: Readonly<Record<string, string>> = {
  gpu: 'gpu-process',
  utility: 'utility',
  zygote: 'zygote'
}

export function expectedCrashpadProcessType(
  source: ProcessGoneSource,
  processType: string
): string | null {
  return source === 'renderer'
    ? 'renderer'
    : (CHILD_CRASHPAD_PROCESS_TYPES[processType.trim().toLowerCase()] ?? null)
}

export const captureProcessMinidump: MinidumpCapture = (crashedAtMs, expectedProcessType) =>
  captureMinidumpSignature(crashedAtMs, { expectedProcessType })

/**
 * Folds the Crashpad signature into a report that is already on disk.
 *
 * Why separate from the record write: an exit code of 0x80000003 only says "a
 * CHECK fired"; the name, file and line live in the dump, which Crashpad is
 * still writing when process-gone fires. Waiting inline would stall recovery.
 */
export async function attachMinidumpSignature(
  store: MinidumpDetailStore,
  reportId: string,
  crashedAtMs: number,
  expectedProcessType: string | null,
  capture: MinidumpCapture
): Promise<void> {
  const captured = expectedProcessType ? await capture(crashedAtMs, expectedProcessType) : null
  if (!captured) {
    await store.attachDetails(reportId, { minidumpStatus: 'absent' })
    return
  }
  const signatureDetails = sanitizeCrashReportDetails(minidumpSignatureDetails(captured.signature))
  await store.attachDetails(reportId, {
    ...signatureDetails,
    minidumpStatus: 'captured',
    minidumpPath: captured.filePath,
    minidumpBytes: captured.sizeBytes
  })
  // Why: the crash-report record is capped at 5 entries and is user-facing;
  // the span is what makes the signature countable in the diagnostics bundle.
  const span = startSpan('electron.minidump_signature', {
    attributes: {
      'crash.report_id': reportId,
      'crash.minidump_bytes': captured.sizeBytes,
      ...signatureDetails
    }
  })
  span.end()
  flushActiveSink()
}
