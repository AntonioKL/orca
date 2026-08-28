import { afterEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { RpcDispatcher } from '../dispatcher'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import { ORCHESTRATION_METHODS } from './orchestration'

describe('orchestration coordinator caller attestation', () => {
  const harness = createOrchestrationRpcHarness()

  afterEach(() => harness.cleanup())

  it('rejects an identity-less caller that names the current coordinator handle', async () => {
    const { db, runtime } = harness.setup()
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const response = await dispatcher.dispatch({
      id: 'rpc_identity-less-coordinator',
      authToken: 'test-token',
      method: 'orchestration.taskCreate',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      params: {
        spec: 'impersonated coordinator mutation',
        run: db.getCurrentRunForPane(harness.coordinatorPaneKey)!.id,
        callerTerminalHandle: 'term_coord'
      }
    })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'consumer_fenced',
        message: expect.stringContaining('authenticated identity from a live Orca agent terminal'),
        data: {
          effectsApplied: false,
          nextSteps: expect.arrayContaining([
            expect.stringContaining('Omit --from'),
            expect.stringContaining('copied terminal handle does not grant mutation authority')
          ])
        }
      }
    })
  })
})
