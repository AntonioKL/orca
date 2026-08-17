import { describe, expect, it } from 'vitest'
import { TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY } from '../../../../../shared/protocol-version'
import type { ExecutionHostRegistryEntry } from '../../../../../shared/execution-host-registry'
import { getTaskSourceHostAvailabilityForHost } from './task-source-host-availability'

describe('getTaskSourceHostAvailabilityForHost', () => {
  it('returns null when there is no host', () => {
    expect(getTaskSourceHostAvailabilityForHost(null, 'local')).toBeNull()
  })

  it('reports a runtime still checking capabilities', () => {
    const host = {
      id: 'runtime:env-1',
      kind: 'runtime',
      label: 'Env',
      health: 'available'
    } as unknown as ExecutionHostRegistryEntry
    expect(getTaskSourceHostAvailabilityForHost(host, 'runtime:env-1')).toEqual({
      hostId: 'runtime:env-1',
      reason: 'checking-task-source-capability'
    })
  })

  it('reports a runtime missing the task-source capability', () => {
    const host = {
      id: 'runtime:env-1',
      kind: 'runtime',
      label: 'Env',
      health: 'available',
      capabilities: []
    } as unknown as ExecutionHostRegistryEntry
    expect(getTaskSourceHostAvailabilityForHost(host, 'runtime:env-1')).toEqual({
      hostId: 'runtime:env-1',
      reason: 'missing-task-source-capability'
    })
  })

  it('returns null for a healthy local host', () => {
    const host = {
      id: 'local',
      kind: 'local',
      label: 'This Mac',
      health: 'local'
    } as unknown as ExecutionHostRegistryEntry
    expect(getTaskSourceHostAvailabilityForHost(host, 'local')).toBeNull()
  })

  it('passes through unhealthy host status', () => {
    const host = {
      id: 'ssh:box',
      kind: 'ssh',
      label: 'Box',
      health: 'offline',
      connectionStatus: 'disconnected',
      capabilities: [TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY]
    } as unknown as ExecutionHostRegistryEntry
    expect(getTaskSourceHostAvailabilityForHost(host, 'ssh:box')).toEqual({
      hostId: 'ssh:box',
      health: 'offline',
      status: 'disconnected'
    })
  })
})
