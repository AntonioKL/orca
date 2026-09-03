import { describe, expect, it } from 'vitest'
import { retainStructuredSessionOperationId } from './mobile-structured-agent-session-rpc'

describe('structured session operation retention', () => {
  it('evicts the oldest ambiguous operation id at the retention bound', () => {
    const operationIds = new Map<string, string>()
    for (let index = 0; index < 129; index += 1) {
      retainStructuredSessionOperationId(operationIds, `request-${index}`, `operation-${index}`)
    }

    expect(operationIds).toHaveLength(128)
    expect(operationIds.has('request-0')).toBe(false)
    expect(operationIds.get('request-128')).toBe('operation-128')
  })
})
