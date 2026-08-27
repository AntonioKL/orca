import type { TuiAgent } from '../../../../shared/tui-agent'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'

export function resolveNativeChatRenderAgent({
  structuredSessionId,
  structuredSessionAgent,
  terminalAgent
}: {
  structuredSessionId: string | null
  structuredSessionAgent: unknown
  terminalAgent: TuiAgent | null
}): TuiAgent | null {
  if (!structuredSessionId) {
    return terminalAgent
  }
  return isAgentSessionHandleProvider(structuredSessionAgent) ? structuredSessionAgent : null
}
