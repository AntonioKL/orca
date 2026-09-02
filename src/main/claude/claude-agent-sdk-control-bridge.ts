import type {
  CanUseTool,
  OnUserDialog,
  PermissionResult,
  UserDialogResult
} from '@anthropic-ai/claude-agent-sdk'
import type {
  ClaudeControlCancelRequest,
  ClaudeControlRequest,
  ClaudeControlResponder,
  ClaudeStreamJsonConnectionHandlers
} from './claude-stream-json-connection'

type Settlement = {
  resolve: (response: unknown) => void
  reject: (error: Error) => void
}

export type ClaudeAgentSdkControlBridge = {
  canUseTool: CanUseTool
  onUserDialog: OnUserDialog
  respond: (requestId: string, response: unknown) => Promise<void>
  respondWithError: (requestId: string, error: string) => Promise<void>
  /** Stop turning SDK aborts into cancellations once Orca is tearing the session down. */
  stopCancelling: () => void
}

/**
 * The SDK consumes the CLI's control envelopes, so inbound permission requests
 * arrive as callbacks. Rebuild the wire frame Orca's prompt registry and journal
 * already key on, and settle the callback from the existing responder contract.
 */
export function createClaudeAgentSdkControlBridge(
  handlers: ClaudeStreamJsonConnectionHandlers
): ClaudeAgentSdkControlBridge {
  const pending = new Map<string, Settlement>()
  let cancelling = true

  const responder: ClaudeControlResponder = {
    respond: async (requestId, response) => {
      pending.get(requestId)?.resolve(response)
      pending.delete(requestId)
    },
    respondWithError: async (requestId, error) => {
      pending.get(requestId)?.reject(new Error(error))
      pending.delete(requestId)
    }
  }

  const settleFrom = (
    requestId: string,
    request: ClaudeControlRequest,
    signal: AbortSignal
  ): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, { resolve, reject })
      signal.addEventListener(
        'abort',
        () => {
          if (pending.delete(requestId) && cancelling) {
            handlers.onControlCancelRequest?.({
              type: 'control_cancel_request',
              request_id: requestId
            } satisfies ClaudeControlCancelRequest)
          }
          // Null is the SDK's "no response written" sentinel: a cancelled request
          // must not be answered, only forgotten.
          resolve(null)
        },
        { once: true }
      )
      handlers.onControlRequest?.(request, responder)
    })

  return {
    canUseTool: (toolName, input, options) =>
      settleFrom(
        options.requestId,
        {
          type: 'control_request',
          request_id: options.requestId,
          request: {
            subtype: 'can_use_tool',
            tool_name: toolName,
            input,
            tool_use_id: options.toolUseID,
            ...(options.suggestions ? { permission_suggestions: options.suggestions } : {}),
            ...(options.blockedPath === undefined ? {} : { blocked_path: options.blockedPath }),
            ...(options.decisionReason === undefined
              ? {}
              : { decision_reason: options.decisionReason }),
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(options.displayName === undefined ? {} : { display_name: options.displayName }),
            ...(options.description === undefined ? {} : { description: options.description }),
            ...(options.agentID === undefined ? {} : { agent_id: options.agentID })
          }
        },
        options.signal
      ) as Promise<PermissionResult | null>,
    onUserDialog: (request, options) =>
      settleFrom(
        options.requestId,
        {
          type: 'control_request',
          request_id: options.requestId,
          request: {
            subtype: 'request_user_dialog',
            dialog_kind: request.dialogKind,
            payload: request.payload,
            ...(request.toolUseID === undefined ? {} : { tool_use_id: request.toolUseID })
          }
        },
        options.signal
      ) as Promise<UserDialogResult | null>,
    respond: responder.respond,
    respondWithError: responder.respondWithError,
    stopCancelling: () => {
      cancelling = false
    }
  }
}
