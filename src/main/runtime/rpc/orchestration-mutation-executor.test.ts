import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import type { RpcRequest } from './core'
import { OrchestrationMutationExecutor } from './orchestration-mutation-executor'

const promptParams = {
  terminal: 'term-prompt',
  text: 'retry safely',
  enter: true,
  agentPrompt: true,
  client: { id: 'orca-cli', type: 'desktop' }
} as const

function promptRequest(requestId: string): RpcRequest {
  return {
    id: `rpc-${requestId}`,
    authToken: 'token',
    method: 'terminal.send',
    orchestrationRequestId: requestId,
    params: promptParams
  }
}

function createHarness() {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPromptRequestBinding').mockReturnValue({
    ptyId: 'pty-prompt',
    processIncarnation: 'incarnation-1',
    generation: 1
  })
  return { db, executor: new OrchestrationMutationExecutor(runtime) }
}

describe('terminal prompt mutation receipt retry boundary', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
    vi.restoreAllMocks()
  })

  it.each(['terminal_not_writable', 'terminal_handle_stale', 'request_aborted'])(
    'discards a %s receipt before effects become possible',
    async (errorCode) => {
      const harness = createHarness()
      databases.push(harness.db)
      const requestId = `pre-write-${errorCode}`
      const invoke = vi
        .fn()
        .mockRejectedValueOnce(new Error(errorCode))
        .mockResolvedValueOnce({ send: { accepted: true } })

      await expect(
        harness.executor.run(promptRequest(requestId), promptParams, invoke)
      ).rejects.toThrow(errorCode)
      expect(
        harness.db.getMutationReceipt(
          harness.db.getOrCreateLocalMutationCallerFingerprint(),
          requestId
        )
      ).toBeUndefined()

      await expect(
        harness.executor.run(promptRequest(requestId), promptParams, invoke)
      ).resolves.toMatchObject({ mutation: { replayed: false } })
      expect(invoke).toHaveBeenCalledTimes(2)
    }
  )

  it('keeps a failed receipt after the write boundary becomes ambiguous', async () => {
    const harness = createHarness()
    databases.push(harness.db)
    const invoke = vi.fn((mutation) => {
      mutation?.markEffectPossible()
      throw new Error('terminal_not_writable')
    })

    await expect(
      harness.executor.run(promptRequest('post-write'), promptParams, invoke)
    ).rejects.toThrow('terminal_not_writable')
    await expect(
      harness.executor.run(promptRequest('post-write'), promptParams, invoke)
    ).rejects.toMatchObject({ code: 'operation_unknown' })
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('keeps an uncheckpointed pending worker_done fenced after restart', async () => {
    const harness = createHarness()
    databases.push(harness.db)
    const params = { type: 'worker_done' }
    const request: RpcRequest = {
      id: 'rpc-uncheckpointed-worker-done',
      authToken: 'token',
      method: 'orchestration.send',
      orchestrationRequestId: 'uncheckpointed-worker-done',
      params
    }
    harness.db.beginMutationReceipt({
      callerFingerprint: harness.db.getOrCreateLocalMutationCallerFingerprint(),
      requestId: 'uncheckpointed-worker-done',
      method: request.method,
      payloadHash: createHash('sha256')
        .update(JSON.stringify({ method: request.method, params }))
        .digest('hex')
    })
    const invoke = vi.fn()

    await expect(harness.executor.run(request, params, invoke)).rejects.toMatchObject({
      code: 'operation_unknown'
    })
    expect(invoke).not.toHaveBeenCalled()
  })
})
