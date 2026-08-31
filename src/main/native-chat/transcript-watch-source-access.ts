import { createRunningGuardedTranscriptNativeWatcher } from './wsl-transcript-watcher-running-guard'
import { readTranscriptBoundaryFingerprint } from './transcript-boundary-fingerprint'
import type { TranscriptFileSource } from './transcript-file-source'
import {
  boundaryFingerprint,
  readTranscriptFileVersion,
  type TranscriptFileVersion
} from './transcript-file-version'
import { wslGatedStat } from './wsl-transcript-fs-access'

export async function probeTranscriptWatchFile(
  filePath: string,
  fileSource: TranscriptFileSource | undefined,
  signal?: AbortSignal
): Promise<void> {
  await (fileSource ? fileSource.stat(filePath) : wslGatedStat(filePath, 'exact', signal))
  signal?.throwIfAborted()
}

export async function readTranscriptWatchFileVersion(
  filePath: string,
  fileSource: TranscriptFileSource | undefined,
  signal: AbortSignal
): Promise<TranscriptFileVersion> {
  const version = fileSource
    ? await fileSource.stat(filePath)
    : await readTranscriptFileVersion(filePath, signal)
  signal.throwIfAborted()
  return version
}

export async function readTranscriptWatchBoundary(
  filePath: string,
  offset: number,
  fileSource: TranscriptFileSource | undefined,
  signal: AbortSignal
): Promise<string> {
  const fingerprint = fileSource
    ? await readTranscriptBoundaryFingerprint(filePath, offset, fileSource)
    : await boundaryFingerprint(filePath, offset, signal)
  signal.throwIfAborted()
  return fingerprint
}

export function createSourceAwareTranscriptNativeWatcher(
  filePath: string,
  fileSource: TranscriptFileSource | undefined,
  onEvent: () => void,
  onRetry: () => void
) {
  return !fileSource || fileSource.supportsNativeWatch
    ? createRunningGuardedTranscriptNativeWatcher(filePath, onEvent, onRetry)
    : {
        bind: () => false,
        invalidate: () => {},
        needsRebind: () => false,
        dispose: () => {}
      }
}
