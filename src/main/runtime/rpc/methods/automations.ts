import { defineMethod, type RpcMethod } from '../core'
import {
  AutomationCreate,
  AutomationId,
  AutomationList,
  AutomationRuns,
  AutomationUpdate
} from './automation-schemas'

export const AUTOMATION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'automation.list',
    params: AutomationList,
    // Why: a scoped caller gets the qualified projection; a parameterless one keeps the legacy payload.
    handler: (params, { runtime }) =>
      params.selector
        ? runtime.listAutomationsForScope({ selector: params.selector })
        : { automations: runtime.listAutomations() }
  }),
  defineMethod({
    name: 'automation.show',
    params: AutomationId,
    // Why: the owner rides along so a client that cannot project one itself — the
    // CLI — can echo it back on the mutation that follows. Optional: an older
    // host omits it, and an older client ignores it.
    handler: (params, { runtime }) => {
      const automation = runtime.showAutomation(params.id, params.expectedOwner)
      const owner = runtime.automationOwnerPrecondition(params.id)
      return owner ? { automation, owner } : { automation }
    }
  }),
  defineMethod({
    name: 'automation.create',
    params: AutomationCreate,
    handler: async (params, { runtime }) => ({
      automation: await runtime.createAutomation(params)
    })
  }),
  defineMethod({
    name: 'automation.update',
    params: AutomationUpdate,
    handler: async (params, { runtime }) => ({
      automation: await runtime.updateAutomation(params.id, params.updates, {
        expectedOwner: params.expectedOwner,
        destination: params.destination
      })
    })
  }),
  defineMethod({
    name: 'automation.delete',
    params: AutomationId,
    handler: (params, { runtime }) => runtime.deleteAutomation(params.id, params.expectedOwner)
  }),
  defineMethod({
    name: 'automation.runNow',
    params: AutomationId,
    handler: async (params, { runtime }) => ({
      run: await runtime.runAutomationNow(params.id, params.expectedOwner)
    })
  }),
  defineMethod({
    name: 'automation.runs',
    params: AutomationRuns,
    handler: (params, { runtime }) => ({
      runs: runtime.listAutomationRuns(params.automationId, params.expectedOwner)
    })
  })
]
