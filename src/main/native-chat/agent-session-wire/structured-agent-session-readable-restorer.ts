import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { RestoredStructuredAgentSessionRead } from './structured-agent-session-read-restore'
import { restoreStructuredAgentSessionsOnRestart } from './structured-agent-session-restart-restore'

export class StructuredAgentSessionReadableRestorer {
  private restorePromise: Promise<void> | null = null

  constructor(
    private readonly input: {
      store: AgentSessionRecordStore
      journalRoot: string
      supportsRecord: (record: AgentSessionRecord) => boolean
      reconcile: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
      resolveRecovery: (sessionId: string) => Promise<unknown>
      serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
      hasSession: (sessionId: string) => boolean
      onReadable: (sessionId: string, restored: RestoredStructuredAgentSessionRead) => void
      restoreHandoff: (sessionId: string) => Promise<void>
    }
  ) {}

  restore(): Promise<void> {
    this.restorePromise ??= this.restoreReadableSessions().catch((error: unknown) => {
      this.restorePromise = null
      throw error
    })
    return this.restorePromise
  }

  private async restoreReadableSessions(): Promise<void> {
    await restoreStructuredAgentSessionsOnRestart({
      ...this.input,
      records: this.input.store.listRecords().filter(this.input.supportsRecord)
    })
  }
}
