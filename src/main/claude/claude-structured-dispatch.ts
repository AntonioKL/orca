import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeSession } from './claude-structured-session-state'
import { readClaudeFrameString } from './claude-structured-init-proof'

export function resolveClaudeReplayWaiter(
  session: ClaudeSession,
  message: Record<string, unknown>
): void {
  const isUserReplay = message.type === 'user' && message.parent_tool_use_id === null
  if (!isUserReplay || readClaudeFrameString(message, 'session_id') !== session.providerSessionId) {
    return
  }
  const uuid = readClaudeFrameString(message, 'uuid')
  const waiter = uuid ? session.dispatchWaiters.shift() : undefined
  if (waiter && uuid) {
    clearTimeout(waiter.timer)
    waiter.resolve(uuid)
  }
}

async function messageContent(body: AgentJournalMessageItem): Promise<unknown[]> {
  if (body.role !== 'user') {
    throw new Error('Claude dispatch accepts only user messages')
  }
  const content: unknown[] = []
  for (const block of body.blocks as NativeChatBlock[]) {
    if (block.type === 'text' && block.text.length > 0) {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image-ref') {
      throw new Error('Claude structured image dispatch is not available yet')
    }
  }
  if (content.length === 0) {
    throw new Error('Claude dispatch requires text')
  }
  return content
}

function waitForReplay(session: ClaudeSession, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const waiter = {
      resolve,
      timer: setTimeout(() => {
        const index = session.dispatchWaiters.indexOf(waiter)
        if (index !== -1) {
          session.dispatchWaiters.splice(index, 1)
        }
        resolve(null)
      }, timeoutMs)
    }
    waiter.timer.unref?.()
    session.dispatchWaiters.push(waiter)
  })
}

export async function dispatchClaudeTurn(
  session: ClaudeSession,
  input: { clientMessageId: string; body: AgentJournalMessageItem },
  timeoutMs: number
): Promise<AgentSessionDispatchOutcome> {
  let content: unknown[]
  try {
    content = await messageContent(input.body)
  } catch (error) {
    return { state: 'rejected', reason: (error as Error).message }
  }
  const replayed = waitForReplay(session, timeoutMs)
  try {
    await session.connection.send({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: session.providerSessionId
    })
  } catch (error) {
    const waiter = session.dispatchWaiters.shift()
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve(null)
    }
    return { state: 'unknown', reason: (error as Error).message }
  }
  const uuid = await replayed
  return uuid
    ? {
        state: 'accepted',
        providerIdentity: { provider: 'claude', sessionId: session.providerSessionId, uuid }
      }
    : { state: 'unknown', reason: 'claude accepted a message but did not replay its uuid in time' }
}
