import type {
  AgentSessionOwnerRuntimeKind,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { findJournalFileFormatRemnant } from '../agent-session-journal/journal-file-format-remnant'
import { loadJournal } from '../agent-session-journal/journal-open'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import {
  attachFingerprintFields,
  journalIdentityFor,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'

export type RestoredStructuredAgentSessionRead = {
  journal: AgentSessionJournal
  params: AgentSessionAttachParams
  fence: number
  hasProviderChild: false
  acquisitionGeneration: null
}

export async function restoreStructuredAgentSessionRead(
  store: AgentSessionRecordStore,
  journalRoot: string,
  sessionId: string
): Promise<RestoredStructuredAgentSessionRead | null> {
  const record = store.getRecord(sessionId)
  if (!record) {
    return null
  }
  const params = attachParamsForRecord(record, {
    clientOperationId: `read-restore:${record.sessionId}`,
    expectedRuntimeFence: record.lease.runtimeFence
  })
  const journalDir = journalDirectoryFor(journalRoot, {
    workspaceId: record.location.workspaceId,
    sessionId
  })
  const loaded = loadJournal(journalDir, sessionId)
  if (loaded?.corrupt) {
    return null
  }
  // No `journal.db` is not automatically "nothing to restore": a session still in
  // the pre-SQLite format has its history in a `log.jsonl` beside it, and opening
  // the journal replays it. Dropping it here instead would leave the session
  // unpublished, which is also what prunes its tab out of the saved workspace.
  if (!loaded && !(await findJournalFileFormatRemnant(journalDir))) {
    return null
  }
  const journal = await openAgentSessionJournal({
    identity: journalIdentityFor(record, params),
    journalDir,
    ...(loaded ? { loaded } : {})
  })
  // Read restore opens the journal and nothing else: no adapter call, so no provider child.
  return {
    journal,
    params,
    fence: record.lease.runtimeFence,
    hasProviderChild: false,
    acquisitionGeneration: null
  }
}

export function attachParamsForRecord(
  record: AgentSessionRecord,
  input: {
    clientOperationId: string
    expectedRuntimeFence: number
    runtimeKind?: AgentSessionOwnerRuntimeKind
  }
): AgentSessionAttachParams {
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: record.sessionId,
      clientOperationId: input.clientOperationId,
      expectedRuntimeFence: input.expectedRuntimeFence,
      payloadFingerprint: ''
    },
    location: record.location,
    provider: record.provider,
    agent: record.provider,
    accountHome: record.accountHome,
    runtimeKind: input.runtimeKind ?? record.lease.runtimeKind
  }
  return {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: record.sessionId,
        fields: attachFingerprintFields(params)
      })
    }
  }
}
