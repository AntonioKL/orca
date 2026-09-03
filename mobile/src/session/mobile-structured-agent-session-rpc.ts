import type { AgentSessionMutationResult } from '../../../src/shared/agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../src/shared/structured-agent-session-mutation'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { RpcClient } from '../transport/rpc-client'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS } from './mobile-native-chat-send'

export const STRUCTURED_SEND_TIMEOUT_MS = 15_000

export type StructuredAgentSessionMutationCallResult<TValue> =
  | { status: 'accepted'; value: TValue }
  | { status: 'refused'; message: string }
  | { status: 'failed'; message: string }
  | { status: 'unknown' }

export type StructuredAgentSessionMutationResult<TValue> =
  | { status: 'accepted'; value: TValue; sameFence: boolean }
  | { status: 'rejected' }
  | { status: 'unknown' }

export type StructuredAgentSessionMutate = <TValue>(
  method: string,
  fingerprintMethod: string,
  fields: Record<string, unknown>
) => Promise<StructuredAgentSessionMutationResult<TValue>>

export async function callAgentSession<TResult>(
  client: RpcClient,
  method: string,
  params: unknown,
  timeoutMs = STRUCTURED_SEND_TIMEOUT_MS,
  options?: { failWhenDisconnected?: boolean }
): Promise<TResult> {
  const response = await client.sendRequest(method, params, {
    timeoutMs,
    budgetSpansConnect: true,
    ...(options?.failWhenDisconnected ? { failWhenDisconnected: true } : {})
  })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as TResult
}

export function structuredSessionOperationId(): string {
  const randomUuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? () => globalThis.crypto.randomUUID()
      : () => {
          return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(
            ''
          )
        }
  return createStructuredAgentSessionOperationId(randomUuid)
}

const MAX_RETAINED_OPERATION_IDS = 128

export function retainStructuredSessionOperationId(
  operationIds: Map<string, string>,
  key: string,
  operationId = structuredSessionOperationId()
): string {
  operationIds.delete(key)
  operationIds.set(key, operationId)
  while (operationIds.size > MAX_RETAINED_OPERATION_IDS) {
    const oldest = operationIds.keys().next().value
    if (oldest === undefined) {
      break
    }
    operationIds.delete(oldest)
  }
  return operationId
}

export function timeoutForDeadline(deadline: number | undefined): number | null {
  if (deadline === undefined) {
    return STRUCTURED_SEND_TIMEOUT_MS
  }
  const timeoutMs = deadline - Date.now()
  return timeoutMs >= MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS ? timeoutMs : null
}

export async function requestStructuredAgentSessionMutation<TValue>(args: {
  client: RpcClient
  method: string
  fingerprintMethod: string
  sessionId: string
  expectedRuntimeFence: number
  fields: Record<string, unknown>
  clientOperationId?: string
  retryUnknown?: boolean
  timeoutMs?: number
}): Promise<StructuredAgentSessionMutationCallResult<TValue>> {
  const {
    client,
    method,
    fingerprintMethod,
    sessionId,
    expectedRuntimeFence,
    fields,
    clientOperationId,
    retryUnknown,
    timeoutMs
  } = args
  try {
    const result = await callAgentSession<AgentSessionMutationResult<TValue>>(
      client,
      method,
      {
        envelope: {
          sessionId,
          clientOperationId: clientOperationId ?? structuredSessionOperationId(),
          expectedRuntimeFence,
          payloadFingerprint: structuredAgentSessionPayloadFingerprint({
            method: fingerprintMethod,
            sessionId,
            fields
          })
        },
        ...(retryUnknown ? { retryUnknown: true } : {}),
        ...fields
      },
      timeoutMs
    )
    return result.ok
      ? { status: 'accepted', value: result.value }
      : { status: 'refused', message: result.refusal.message }
  } catch (error) {
    if (isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)) {
      return { status: 'unknown' }
    }
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : 'Request not sent'
    }
  }
}
