import type {
  OrchestrationWorkerReadResult,
  OrchestrationWorkerReadSource
} from '../../../../shared/orchestration-worker-output'
import type { PtyLivenessVerdict } from '../../../../shared/pty-liveness-verdict'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type {
  WorkerTerminalArchiveRow,
  WorkerTerminalResourceRow
} from '../../orchestration/worker-terminal-ownership'
import type {
  WorkerTerminalTailArchive,
  WorkerTranscriptPinArchive,
  WorkerTranscriptSnapshotArchive
} from '../../orchestration/worker-output-archive'
import { clampWorkerTranscriptLimit } from '../../orchestration/worker-transcript-payload'
import {
  createWorkerOutputSourceIdentity,
  decodeWorkerOutputCursor,
  encodeWorkerOutputCursor
} from '../../orchestration/worker-output-cursor'
import { readWorkerTranscript } from '../../orchestration/worker-transcript-read'

const ARCHIVED_TERMINAL_PAGE_LINES = 2_000

// Serves the frozen output source after the live PTY is gone. Transcript pins read the exact
// provider transcript directly; terminal archives page the stored redacted tail. Cursors stay
// Dispatch-scoped and source-pinned exactly like live reads.
export async function readArchivedWorkerOutput(args: {
  db: OrchestrationDb
  dispatchId: string
  workerState: string
  resource: Pick<WorkerTerminalResourceRow, 'id' | 'terminal_handle' | 'release_state'>
  source?: OrchestrationWorkerReadSource
  cursor?: string | number
  limit?: number
  /** Process evidence is separate from the fact that output was archived. */
  liveness?: PtyLivenessVerdict['status']
}): Promise<OrchestrationWorkerReadResult> {
  const archive = args.db.getWorkerTerminalArchive(args.dispatchId)
  if (!archive) {
    throw new OrchestrationError(
      'archive_unavailable',
      `Dispatch ${args.dispatchId} was released without a preserved output archive.`
    )
  }
  if (archive.kind === 'transcript_pin') {
    if (args.source === 'terminal') {
      throw new OrchestrationError(
        'archive_unavailable',
        `Dispatch ${args.dispatchId} preserved structured transcript output only; terminal output was released.`
      )
    }
    const content = JSON.parse(archive.content) as
      | WorkerTranscriptPinArchive
      | WorkerTranscriptSnapshotArchive
    return isTranscriptSnapshot(content)
      ? readFrozenTranscript(args, archive, content)
      : readLegacyPinnedTranscript(args, content)
  }
  if (args.source === 'transcript') {
    throw new OrchestrationError(
      'transcript_required',
      `Structured output is unavailable for released Dispatch ${args.dispatchId}: the archive holds terminal output only.`
    )
  }
  return readArchivedTerminalTail(args, archive)
}

function readFrozenTranscript(
  args: Parameters<typeof readArchivedWorkerOutput>[0],
  archive: WorkerTerminalArchiveRow,
  snapshot: WorkerTranscriptSnapshotArchive
): OrchestrationWorkerReadResult {
  const cursor = decodeWorkerOutputCursor(args.cursor, args.dispatchId)
  const sourceIdentity = createWorkerOutputSourceIdentity([
    'released-transcript-snapshot',
    args.resource.id,
    snapshot.processIncarnation,
    archive.created_at
  ])
  if (cursor && (cursor.source !== 'transcript' || cursor.sourceIdentity !== sourceIdentity)) {
    throw sourceChanged()
  }
  const start = Math.min(cursor?.position ?? 0, snapshot.messages.length)
  const end = Math.min(start + clampWorkerTranscriptLimit(args.limit), snapshot.messages.length)
  const nextCursor = encodeWorkerOutputCursor(args.dispatchId, 'transcript', sourceIdentity, end)
  const status = archivedStatus(args)
  const snapshotClipping = snapshot.clipping ?? (snapshot.limited ? ['archive_message_limit'] : [])
  const clipping = [
    ...(end < snapshot.messages.length ? ['message_limit'] : []),
    ...snapshotClipping
  ]
  return {
    dispatchId: args.dispatchId,
    source: 'transcript',
    sourceIdentity,
    provider: snapshot.agent,
    transcript: {
      messages: snapshot.messages.slice(start, end),
      nextCursor,
      limited: snapshot.limited || end < snapshot.messages.length,
      returnedMessageCount: end - start
    },
    cursor: nextCursor,
    status,
    fallbackReason: null,
    sourceExact: true,
    contentComplete: !snapshot.limited && end >= snapshot.messages.length,
    ...(clipping.length > 0 ? { clipping: [...new Set(clipping)] } : {}),
    warnings: [
      ...snapshot.warnings,
      ...(snapshotClipping.some((reason) => reason !== 'transcript_payload')
        ? ['Older transcript messages were omitted from the bounded archive.']
        : [])
    ],
    archived: true
  }
}

async function readLegacyPinnedTranscript(
  args: Parameters<typeof readArchivedWorkerOutput>[0],
  pin: WorkerTranscriptPinArchive
): Promise<OrchestrationWorkerReadResult> {
  const cursor = decodeWorkerOutputCursor(args.cursor, args.dispatchId)
  if (cursor && (cursor.source !== 'transcript' || !cursor.boundaryCheckpoint)) {
    throw sourceChanged()
  }
  const transcript = await readWorkerTranscript({
    agent: pin.agent,
    sessionId: pin.providerSessionId,
    transcriptPath: pin.transcriptPath ?? undefined,
    offset: cursor?.position,
    endOffset: pin.endOffset,
    expectedBoundaryCheckpoint: cursor?.boundaryCheckpoint ?? undefined,
    limit: args.limit
  })
  if (!transcript.ok) {
    if (transcript.reason === 'source_changed') {
      throw sourceChanged()
    }
    throw new OrchestrationError(
      'transcript_required',
      `The pinned transcript for released Dispatch ${args.dispatchId} is unavailable: ${transcript.reason}.`,
      { reason: transcript.reason }
    )
  }
  const sourceIdentity = createWorkerOutputSourceIdentity([
    'released-transcript',
    pin.processIncarnation,
    pin.agent,
    pin.providerSessionKey,
    pin.providerSessionId,
    pin.transcriptPath ?? '',
    String(pin.endOffset),
    transcript.sourceFingerprint
  ])
  if (cursor && cursor.sourceIdentity !== sourceIdentity) {
    throw sourceChanged()
  }
  const nextCursor = encodeWorkerOutputCursor(
    args.dispatchId,
    'transcript',
    sourceIdentity,
    transcript.nextOffset,
    transcript.boundaryCheckpoint
  )
  const status = archivedStatus(args)
  return {
    dispatchId: args.dispatchId,
    source: 'transcript',
    sourceIdentity,
    provider: pin.agent,
    transcript: {
      messages: transcript.messages,
      nextCursor,
      limited: transcript.limited,
      returnedMessageCount: transcript.messages.length
    },
    cursor: nextCursor,
    status,
    fallbackReason: null,
    sourceExact: true,
    contentComplete: !transcript.limited,
    ...(transcript.clipping.length > 0 ? { clipping: transcript.clipping } : {}),
    warnings: transcript.warnings,
    archived: true
  }
}

function isTranscriptSnapshot(
  content: WorkerTranscriptPinArchive | WorkerTranscriptSnapshotArchive
): content is WorkerTranscriptSnapshotArchive {
  return 'version' in content && content.version === 2
}

function readArchivedTerminalTail(
  args: Parameters<typeof readArchivedWorkerOutput>[0],
  archive: WorkerTerminalArchiveRow
): OrchestrationWorkerReadResult {
  const content = JSON.parse(archive.content) as WorkerTerminalTailArchive
  const cursor = decodeWorkerOutputCursor(args.cursor, args.dispatchId)
  const sourceIdentity = createWorkerOutputSourceIdentity([
    'released-terminal',
    args.resource.id,
    archive.created_at
  ])
  if (cursor && cursor.source !== 'terminal') {
    throw sourceChanged()
  }
  if (cursor && (cursor.legacy || cursor.sourceIdentity !== sourceIdentity)) {
    throw sourceChanged()
  }
  const start = Math.min(cursor?.position ?? 0, content.lines.length)
  const pageSize = Math.max(1, Math.min(args.limit ?? ARCHIVED_TERMINAL_PAGE_LINES, 10_000))
  const end = Math.min(start + pageSize, content.lines.length)
  const tail = content.lines.slice(start, end)
  const nextCursor =
    end < content.lines.length
      ? encodeWorkerOutputCursor(args.dispatchId, 'terminal', sourceIdentity, end)
      : null
  const status = archivedStatus(args)
  return {
    dispatchId: args.dispatchId,
    source: 'terminal',
    sourceIdentity,
    terminal: {
      handle: args.resource.terminal_handle,
      status: status.terminal,
      tail,
      ...(!cursor && content.draft ? { draft: content.draft } : {}),
      truncated: content.truncated,
      nextCursor,
      returnedLineCount: tail.length
    },
    cursor: nextCursor,
    status,
    fallbackReason: content.fallbackReason ?? null,
    sourceExact: content.sourceExact ?? false,
    contentComplete: content.contentComplete ?? false,
    ...(content.clipping ? { clipping: content.clipping } : {}),
    warnings: content.warnings,
    archived: true
  }
}

function archivedStatus(args: Parameters<typeof readArchivedWorkerOutput>[0]): {
  worker: string
  terminal: 'running' | 'exited' | 'unknown'
  liveness: PtyLivenessVerdict['status']
} {
  // A durable release is host-confirmed only after the close settles. Unknown and
  // in-flight releases retain their archive, but must not manufacture an exit.
  const liveness =
    args.liveness ?? (args.resource.release_state === 'released' ? 'exited' : 'unverifiable')
  return {
    worker: args.workerState,
    terminal: liveness === 'live' ? 'running' : liveness === 'exited' ? 'exited' : 'unknown',
    liveness
  }
}

function sourceChanged(): OrchestrationError {
  return new OrchestrationError(
    'source_changed',
    'The worker output source changed. Start a fresh worker-read without the old cursor.'
  )
}
