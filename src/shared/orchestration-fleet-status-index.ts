import type { AgentStatusIpcPayload } from './agent-status-ipc-payload'
import type { FleetDurableWorker } from './orchestration-fleet-projection'

export type FleetStatusIndex = {
  byDispatchId: Map<string, AgentStatusIpcPayload>
  byPaneKey: Map<string, AgentStatusIpcPayload>
  byTerminalHandle: Map<string, AgentStatusIpcPayload>
  paneOwners: Map<string, Set<string>>
  handleOwners: Map<string, Set<string>>
}

export function createFleetStatusIndex(
  statuses: readonly AgentStatusIpcPayload[],
  workers: readonly FleetDurableWorker[]
): FleetStatusIndex {
  const index: FleetStatusIndex = {
    byDispatchId: new Map(),
    byPaneKey: new Map(),
    byTerminalHandle: new Map(),
    paneOwners: new Map(),
    handleOwners: new Map()
  }
  const paneKeys = new Set<string>()
  const dispatchIds = new Set<string>()
  const terminalHandles = new Set<string>()
  for (const worker of workers) {
    dispatchIds.add(worker.dispatchId)
    if (worker.paneKey) {
      paneKeys.add(worker.paneKey)
      addOwner(index.paneOwners, worker.paneKey, worker.dispatchId)
    }
    if (worker.agentTerminalHandle) {
      terminalHandles.add(worker.agentTerminalHandle)
      addOwner(index.handleOwners, worker.agentTerminalHandle, worker.dispatchId)
    }
  }
  for (const status of statuses) {
    const dispatchId = status.orchestration?.dispatchId
    if (dispatchId && dispatchIds.has(dispatchId)) {
      keepFreshest(index.byDispatchId, dispatchId, status)
    }
    if (paneKeys.has(status.paneKey)) {
      keepFreshest(index.byPaneKey, status.paneKey, status)
    }
    if (status.terminalHandle && terminalHandles.has(status.terminalHandle)) {
      keepFreshest(index.byTerminalHandle, status.terminalHandle, status)
    }
  }
  return index
}

function addOwner(ownersByKey: Map<string, Set<string>>, key: string, dispatchId: string): void {
  const owners = ownersByKey.get(key) ?? new Set<string>()
  owners.add(dispatchId)
  ownersByKey.set(key, owners)
}

function keepFreshest(
  statusesByKey: Map<string, AgentStatusIpcPayload>,
  key: string,
  status: AgentStatusIpcPayload
): void {
  const current = statusesByKey.get(key)
  if (!current || current.receivedAt < status.receivedAt) {
    statusesByKey.set(key, status)
  }
}

type StatusIdentity = AgentStatusIpcPayload & {
  processIncarnation?: string
  endpointId?: string
  endpointIncarnation?: string
}

export function statusForFleetWorker(
  worker: FleetDurableWorker,
  index: FleetStatusIndex
): AgentStatusIpcPayload | undefined {
  const byDispatch = index.byDispatchId.get(worker.dispatchId)
  if (byDispatch && statusIdentityMatchesWorker(worker, byDispatch, index)) {
    return byDispatch
  }
  const candidates = [
    worker.paneKey ? index.byPaneKey.get(worker.paneKey) : undefined,
    worker.agentTerminalHandle ? index.byTerminalHandle.get(worker.agentTerminalHandle) : undefined
  ].filter((status): status is AgentStatusIpcPayload =>
    Boolean(status && statusIdentityMatchesWorker(worker, status, index))
  )
  return candidates.sort((left, right) => right.receivedAt - left.receivedAt)[0]
}

function statusIdentityMatchesWorker(
  worker: FleetDurableWorker,
  status: AgentStatusIpcPayload,
  index: FleetStatusIndex
): boolean {
  const candidate = status as StatusIdentity
  const resource = worker.resource
  const explicitDispatch = candidate.orchestration?.dispatchId
  if (explicitDispatch && explicitDispatch !== worker.dispatchId) {
    return false
  }
  const paneMatches = !worker.paneKey || candidate.paneKey === worker.paneKey
  const handleMatches =
    !worker.agentTerminalHandle || candidate.terminalHandle === worker.agentTerminalHandle
  const processIncarnation = resource?.processIncarnation ?? null
  const endpointId = resource?.endpointId ?? null
  const endpointIncarnation = resource?.endpointIncarnation ?? null
  const remoteTargetId = remoteTargetFromHostScope(resource?.hostScope)
  if (remoteTargetId && candidate.connectionId !== remoteTargetId) {
    return false
  }
  const processMatches = matchesOptionalIdentity(
    candidate.processIncarnation,
    processIncarnation,
    explicitDispatch,
    candidate.providerSessionOnly
  )
  const endpointMatches = matchesOptionalIdentity(
    candidate.endpointId,
    endpointId,
    explicitDispatch,
    candidate.providerSessionOnly
  )
  const endpointIncarnationMatches = matchesOptionalIdentity(
    candidate.endpointIncarnation,
    endpointIncarnation,
    explicitDispatch,
    candidate.providerSessionOnly
  )
  if (!processMatches || !endpointMatches || !endpointIncarnationMatches) {
    return false
  }
  if (explicitDispatch) {
    return (paneMatches && handleMatches) || (handleMatches && Boolean(processIncarnation))
  }
  return (
    paneMatches &&
    handleMatches &&
    uniqueOwner(index.paneOwners, worker.paneKey) &&
    uniqueOwner(index.handleOwners, worker.agentTerminalHandle)
  )
}

function matchesOptionalIdentity(
  observed: string | undefined,
  expected: string | null,
  explicitDispatch: string | undefined,
  providerSessionOnly: boolean | undefined
): boolean {
  return (
    !expected ||
    observed === expected ||
    (!observed && (!explicitDispatch || providerSessionOnly === true))
  )
}

function uniqueOwner(ownersByKey: Map<string, Set<string>>, key: string | null): boolean {
  return key ? ownersByKey.get(key)?.size === 1 : true
}

function remoteTargetFromHostScope(hostScope: string | null | undefined): string | null {
  if (!hostScope) {
    return null
  }
  try {
    const parsed = JSON.parse(hostScope) as { kind?: unknown; targetId?: unknown }
    return parsed.kind !== 'local' && typeof parsed.targetId === 'string' ? parsed.targetId : null
  } catch {
    return null
  }
}
