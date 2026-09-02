import { applyClaudePromptAnswer } from './claude-structured-prompt-replies'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import type { ClaudeSession } from './claude-structured-session-state'

const INTERRUPT_CANCEL_QUEUED_CAPABILITY = 'interrupt_cancel_queued_v1'

/**
 * Interrupt the running turn, then make sure no queued async user message survives to spawn a
 * later unexpected turn. On a CLI advertising `interrupt_cancel_queued_v1` one round trip
 * cancels the queue alongside the abort; otherwise the interrupt receipt lists `still_queued`
 * uuids, and each is withdrawn best-effort with `cancel_async_message`. Older CLIs resolve no
 * receipt, so there is nothing to sweep.
 */
export async function cancelClaudeTurn(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<{ cancelled: boolean }> {
  const cancelQueued = session.capabilities.includes(INTERRUPT_CANCEL_QUEUED_CAPABILITY)
  try {
    const receipt = await session.connection.interrupt({
      ...(cancelQueued ? { cancelQueued: true } : {}),
      timeoutMs
    })
    if (!cancelQueued) {
      for (const uuid of receipt?.still_queued ?? []) {
        await session.connection.cancelAsyncMessage(uuid, { timeoutMs }).catch(() => {})
      }
    }
    return { cancelled: true }
  } catch (error) {
    if (error instanceof ClaudeControlRequestError) {
      return { cancelled: false }
    }
    throw error
  }
}

export async function answerClaudePrompt(
  session: ClaudeSession,
  input: { itemId: string; kind: 'approval' | 'question'; optionId: string }
): Promise<void> {
  const found = session.prompts.find(input.itemId)
  if (!found || found.prompt.kind !== input.kind) {
    throw new Error(`claude is no longer waiting on ${input.itemId}`)
  }
  const response = applyClaudePromptAnswer(found, input.optionId)
  if (response === null) {
    return
  }
  session.prompts.forget(found.prompt)
  found.prompt.settle(response)
}
