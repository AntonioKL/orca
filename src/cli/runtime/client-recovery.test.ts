import { createServer, type Server } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { orchestrationMutationRecoveryError } from '../orchestration-mutation-recovery'
import { RuntimeClient } from './client'

const servers = new Set<Server>()

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
})

describe('RuntimeClient orchestration recovery identity', () => {
  it('attaches the request and exact retry identity to a real RPC failure response', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-recovery-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      let buffer = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline === -1) {
          return
        }
        const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string }
        const response =
          request.method === 'status.get'
            ? {
                id: request.id,
                ok: true,
                result: { capabilities: [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY] },
                _meta: { runtimeId: 'runtime-1' }
              }
            : {
                id: request.id,
                ok: false,
                error: {
                  code: 'runtime_timeout',
                  message: 'request timed out',
                  data: { requestId: 'request_1', dispatchId: 'dispatch_1' }
                },
                _meta: { runtimeId: 'runtime-1' }
              }
        socket.end(`${JSON.stringify(response)}\n`)
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeFileSync(
      join(userDataPath, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'runtime-1',
        pid: 1,
        transports: [{ kind: 'unix', endpoint }],
        authToken: 'token',
        startedAt: 1
      })
    )

    const client = new RuntimeClient(userDataPath, 500, null, null, 'orca')
    try {
      await client.call('orchestration.workerStart', { task: 'task_1' })
      throw new Error('expected worker-start failure')
    } catch (error) {
      const recovered = orchestrationMutationRecoveryError(error) as {
        data?: Record<string, unknown>
      }
      expect(recovered.data).toMatchObject({
        orchestrationRequestId: expect.any(String),
        dispatchId: 'dispatch_1',
        originalCommand: ['orca', 'orchestration', 'worker-start', '--task', 'task_1'],
        recovery: {
          queryCommand: [
            'orca',
            'orchestration',
            'worker-show',
            '--dispatch',
            'dispatch_1',
            '--json'
          ],
          retryCommand: [
            'orca',
            'orchestration',
            'worker-start',
            '--task',
            'task_1',
            '--retry-request',
            expect.any(String)
          ],
          recoveryBlocked: false
        }
      })
    }
  })
})
