import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { RpcSuccess } from '../transport/types'
import { readMobileRuntimeHostPlatform } from '../transport/mobile-runtime-host-platform'
import { MOBILE_TASKS_CAPABILITY } from './mobile-tasks-capability'
import {
  WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS,
  resolveWorktreeCreateIdempotencySupport,
  type WorktreeCreateIdempotencySupport
} from './worktree-create-idempotency-policy'

// Why: older hosts strip worktree.create's clientMutationId, so mobile must not
// replay an ambiguous create unless the host advertises idempotency support.
// Mirrors WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY in the shared protocol.
export const MOBILE_WORKTREE_CREATE_IDEMPOTENCY_CAPABILITY = 'worktree.create-idempotency.v1'

const STATUS_CUTOVER_MAX_RETRIES = 5

export type NewWorktreeRuntimeCapabilities = {
  tasksSupported: boolean
  worktreeCreateIdempotency: WorktreeCreateIdempotencySupport | false
  hostPlatform: NodeJS.Platform | null
}

const UNSUPPORTED_CAPABILITIES: NewWorktreeRuntimeCapabilities = {
  tasksSupported: false,
  worktreeCreateIdempotency: false,
  hostPlatform: null
}

type CapabilityProbeResult = {
  capabilities: NewWorktreeRuntimeCapabilities
  cache: 'authoritative' | 'transient'
}

type CapabilityProbeRecord = {
  client: RpcClient | null
  connectionRevision: number
  cache: 'pending' | CapabilityProbeResult['cache']
  promise: Promise<CapabilityProbeResult>
}

type ConnectionRevision = {
  client: RpcClient | null
  revision: number
  state: ReturnType<RpcClient['getState']> | null
  generation: number | null
  connectedAt: number | null
}

// Why: status.get is safe to replay and must settle before create, independently
// of slower provider probes, so ambiguous cutover retries are gated correctly.
export async function readNewWorktreeRuntimeCapabilities(
  client: RpcClient
): Promise<NewWorktreeRuntimeCapabilities> {
  return (await probeNewWorktreeRuntimeCapabilities(client)).capabilities
}

async function probeNewWorktreeRuntimeCapabilities(
  client: RpcClient
): Promise<CapabilityProbeResult> {
  for (let migrationRetry = 0; ; migrationRetry += 1) {
    try {
      const response = await client.sendRequest('status.get')
      if (!response.ok) {
        return { capabilities: UNSUPPORTED_CAPABILITIES, cache: 'authoritative' }
      }
      const result = (response as RpcSuccess).result as {
        capabilities?: string[]
        worktreeCreateIdempotency?: unknown
      }
      const capabilities = result.capabilities ?? []
      const supportsIdempotency = capabilities.includes(
        MOBILE_WORKTREE_CREATE_IDEMPOTENCY_CAPABILITY
      )
      const advertisedIdempotency = result.worktreeCreateIdempotency
      return {
        capabilities: {
          tasksSupported: capabilities.includes(MOBILE_TASKS_CAPABILITY),
          worktreeCreateIdempotency: supportsIdempotency
            ? advertisedIdempotency === undefined
              ? { dedupeTtlMs: WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS }
              : advertisedIdempotency !== null &&
                  typeof advertisedIdempotency === 'object' &&
                  !Array.isArray(advertisedIdempotency)
                ? resolveWorktreeCreateIdempotencySupport(
                    (advertisedIdempotency as { dedupeTtlMs?: unknown }).dedupeTtlMs
                  )
                : { dedupeTtlMs: 0 }
            : false,
          hostPlatform: readMobileRuntimeHostPlatform(result)
        },
        cache: 'authoritative'
      }
    } catch (error) {
      if (!isLogicalClientCutoverError(error) || migrationRetry >= STATUS_CUTOVER_MAX_RETRIES) {
        return { capabilities: UNSUPPORTED_CAPABILITIES, cache: 'transient' }
      }
    }
  }
}

export function useNewWorktreeRuntimeCapabilities(
  client: RpcClient | null,
  enabled: boolean
): {
  tasksSupported: boolean
  hostPlatform: NodeJS.Platform | null
  getWorktreeCreateCutoverSupport: () => Promise<WorktreeCreateIdempotencySupport | false>
} {
  const [tasksSupported, setTasksSupported] = useState(false)
  const [hostPlatform, setHostPlatform] = useState<NodeJS.Platform | null>(null)
  const capabilityProbeRef = useRef<CapabilityProbeRecord | null>(null)
  const connectionRevisionRef = useRef<ConnectionRevision>(makeConnectionRevision(client))
  if (connectionRevisionRef.current.client !== client) {
    connectionRevisionRef.current = makeConnectionRevision(client)
    capabilityProbeRef.current = null
  }

  const getCapabilityProbe = useCallback((): CapabilityProbeRecord => {
    updateConnectionRevision(connectionRevisionRef.current)
    const current = capabilityProbeRef.current
    // Why: a transient answer gets one shared retry per recovered connection,
    // while a host's authoritative answer remains durable across reconnects.
    if (
      current?.client === client &&
      (current.cache === 'authoritative' ||
        current.connectionRevision === connectionRevisionRef.current.revision)
    ) {
      return current
    }
    const record: CapabilityProbeRecord = {
      client,
      connectionRevision: connectionRevisionRef.current.revision,
      cache: 'pending',
      promise: client
        ? probeNewWorktreeRuntimeCapabilities(client)
        : Promise.resolve({ capabilities: UNSUPPORTED_CAPABILITIES, cache: 'authoritative' })
    }
    capabilityProbeRef.current = record
    void record.promise.then((result) => {
      if (capabilityProbeRef.current === record) {
        record.cache = result.cache
      }
    })
    return record
  }, [client])

  useEffect(() => {
    if (!enabled || !client) {
      return
    }
    let stale = false
    const refresh = (): void => {
      const record = getCapabilityProbe()
      void record.promise.then(({ capabilities }) => {
        if (!stale && capabilityProbeRef.current === record) {
          setTasksSupported(capabilities.tasksSupported)
          setHostPlatform(capabilities.hostPlatform)
        }
      })
    }
    const unsubscribe = client.onStateChange(() => {
      const previousRevision = connectionRevisionRef.current.revision
      updateConnectionRevision(connectionRevisionRef.current)
      if (
        connectionRevisionRef.current.revision !== previousRevision &&
        capabilityProbeRef.current?.cache !== 'authoritative'
      ) {
        refresh()
      }
    })
    refresh()
    return () => {
      stale = true
      unsubscribe()
    }
  }, [client, enabled, getCapabilityProbe, setTasksSupported])

  const getWorktreeCreateCutoverSupport = useCallback(
    () =>
      getCapabilityProbe().promise.then(
        ({ capabilities }) => capabilities.worktreeCreateIdempotency
      ),
    [getCapabilityProbe]
  )
  return { tasksSupported, hostPlatform, getWorktreeCreateCutoverSupport }
}

function makeConnectionRevision(client: RpcClient | null): ConnectionRevision {
  return {
    client,
    revision: 0,
    state: client?.getState() ?? null,
    generation: readLogicalClientGeneration(client),
    connectedAt: client?.getLastConnectedAt() ?? null
  }
}

function updateConnectionRevision(connection: ConnectionRevision): void {
  const { client } = connection
  if (!client) {
    return
  }
  const state = client.getState()
  const generation = readLogicalClientGeneration(client)
  const connectedAt = client.getLastConnectedAt()
  const reconnected = state === 'connected' && connection.state !== 'connected'
  const migrated = generation !== null && generation !== connection.generation
  const connectionChanged = connectedAt !== null && connectedAt !== connection.connectedAt
  connection.state = state
  connection.generation = generation
  connection.connectedAt = connectedAt
  if (reconnected || migrated || connectionChanged) {
    connection.revision += 1
  }
}

function readLogicalClientGeneration(client: RpcClient | null): number | null {
  const getGeneration = (client as (RpcClient & { getGeneration?: () => number }) | null)
    ?.getGeneration
  return getGeneration?.() ?? null
}
