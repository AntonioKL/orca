import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import { transcriptFallbackId } from './transcript-fallback-id'
import {
  MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES,
  type NativeChatLineDecoder
} from './transcript-tail-reader'
import type { TranscriptFileSource } from './transcript-file-source'
import {
  estimateTranscriptMessageRetainedBytes,
  TranscriptMessageRetention
} from './transcript-message-retention'
import { TranscriptRecordBuffer } from './transcript-record-buffer'
import { openTranscriptReadStream, wslGatedStat } from './wsl-transcript-fs-access'

export const APPEND_BATCH_MESSAGE_LIMIT = 40
export const APPEND_BATCH_RETAINED_BYTE_LIMIT = 8 * 1024 * 1024
export const INCREMENTAL_DRAIN_RETAINED_BYTE_LIMIT = 32 * 1024 * 1024
const INCREMENTAL_READ_CHUNK_BYTES = 64 * 1024

export type IncrementalTranscriptState = {
  offset: number
  pendingRecord: TranscriptRecordBuffer
  pendingStart: number
}

type IncrementalTranscriptReadOptions = {
  fileSource?: TranscriptFileSource
  maxDrainRetainedBytes?: number
  signal?: AbortSignal
}

export function createIncrementalTranscriptState(): IncrementalTranscriptState {
  return {
    offset: 0,
    pendingRecord: new TranscriptRecordBuffer(MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES),
    pendingStart: 0
  }
}

export function resetIncrementalTranscriptState(state: IncrementalTranscriptState): void {
  state.offset = 0
  state.pendingRecord.clear()
  state.pendingStart = 0
}

export async function readIncrementalTranscriptMessages(
  filePath: string,
  state: IncrementalTranscriptState,
  decode: NativeChatLineDecoder,
  onBatch?: (messages: NativeChatMessage[]) => void,
  decodeLifecycle?: (line: string, fallbackId: string) => NativeChatTurnLifecycle | null,
  onLifecycle?: (lifecycle: NativeChatTurnLifecycle) => void,
  optionsOrSignal: IncrementalTranscriptReadOptions | AbortSignal = {}
): Promise<NativeChatMessage[]> {
  const options = isAbortSignal(optionsOrSignal) ? { signal: optionsOrSignal } : optionsOrSignal
  const { fileSource, signal } = options
  const end = (
    fileSource ? await fileSource.stat(filePath) : await wslGatedStat(filePath, 'exact', signal)
  ).size
  signal?.throwIfAborted()
  if (end <= state.offset) {
    return []
  }
  const messages: NativeChatMessage[] = []
  let messageBatchBytes = 0
  let drainRetainedBytes = 0
  const requestedDrainLimit = options.maxDrainRetainedBytes
  const maxDrainRetainedBytes =
    Number.isSafeInteger(requestedDrainLimit) && (requestedDrainLimit ?? 0) > 0
      ? Math.min(INCREMENTAL_DRAIN_RETAINED_BYTE_LIMIT, requestedDrainLimit ?? 0)
      : INCREMENTAL_DRAIN_RETAINED_BYTE_LIMIT
  const retainedSnapshot = onBatch ? null : new TranscriptMessageRetention()
  if (fileSource) {
    await readProviderChunks(fileSource)
    return retainedSnapshot?.values() ?? messages
  }
  const stream = openTranscriptReadStream(
    filePath,
    { start: state.offset, end: end - 1 },
    'exact',
    signal
  )
  try {
    let absoluteOffset = state.offset
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      if (!processChunk(chunk, absoluteOffset)) {
        break
      }
      absoluteOffset += chunk.length
      state.offset = absoluteOffset
    }
    return retainedSnapshot?.values() ?? messages
  } finally {
    // Early exits (throw/oversized-record bail) must not leak the fd or, on
    // UNC, the gated handle the generator's finally closes.
    stream.destroy()
  }

  async function readProviderChunks(fileSource: TranscriptFileSource): Promise<void> {
    const reader = await fileSource.open(filePath)
    try {
      let absoluteOffset = state.offset
      while (absoluteOffset < end) {
        signal?.throwIfAborted()
        const requestedBytes = Math.min(INCREMENTAL_READ_CHUNK_BYTES, end - absoluteOffset)
        const chunk = await reader.read(absoluteOffset, requestedBytes)
        signal?.throwIfAborted()
        if (chunk.length === 0 || chunk.length > requestedBytes) {
          throw new Error('Transcript changed during read')
        }
        if (!processChunk(chunk, absoluteOffset)) {
          return
        }
        absoluteOffset += chunk.length
        state.offset = absoluteOffset
      }
    } finally {
      await reader.close()
    }
  }

  function processChunk(chunk: Buffer, absoluteOffset: number): boolean {
    let segmentStart = 0
    let newline = chunk.indexOf(0x0a)
    while (newline >= 0) {
      state.pendingRecord.append(chunk.subarray(segmentStart, newline))
      if (!state.pendingRecord.isOversized && !decodeLine()) {
        const retryOffset = state.pendingStart
        resetPendingLine(retryOffset)
        state.offset = retryOffset
        return false
      }
      resetPendingLine(absoluteOffset + newline + 1)
      segmentStart = newline + 1
      newline = chunk.indexOf(0x0a, segmentStart)
    }
    if (segmentStart < chunk.length) {
      state.pendingRecord.append(chunk.subarray(segmentStart))
    }
    return true
  }

  function resetPendingLine(nextStart: number): void {
    state.pendingRecord.clear()
    state.pendingStart = nextStart
  }

  function decodeLine(): boolean {
    let line = state.pendingRecord.toString()
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    if (!line) {
      return true
    }
    const fallbackId = transcriptFallbackId(filePath, state.pendingStart)
    const message = decode(line, fallbackId)
    const estimatedBytes = message
      ? estimateTranscriptMessageRetainedBytes(state.pendingRecord.byteLength)
      : 0
    if (
      message &&
      onBatch &&
      drainRetainedBytes > 0 &&
      estimatedBytes > maxDrainRetainedBytes - drainRetainedBytes
    ) {
      return false
    }
    const lifecycle = decodeLifecycle?.(line, fallbackId)
    if (lifecycle) {
      onLifecycle?.(lifecycle)
    }
    if (!message) {
      return true
    }
    if (retainedSnapshot) {
      retainedSnapshot.add(message, state.pendingRecord.byteLength)
      return true
    }
    drainRetainedBytes += estimatedBytes
    if (
      onBatch &&
      messages.length > 0 &&
      estimatedBytes > APPEND_BATCH_RETAINED_BYTE_LIMIT - messageBatchBytes
    ) {
      onBatch(messages.splice(0))
      messageBatchBytes = 0
    }
    messages.push(message)
    messageBatchBytes += estimatedBytes
    if (onBatch && messages.length >= APPEND_BATCH_MESSAGE_LIMIT) {
      onBatch(messages.splice(0))
      messageBatchBytes = 0
    }
    return true
  }
}

function isAbortSignal(
  value: IncrementalTranscriptReadOptions | AbortSignal
): value is AbortSignal {
  return 'aborted' in value
}
