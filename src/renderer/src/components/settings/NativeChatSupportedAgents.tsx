import { NATIVE_CHAT_SUPPORTED_AGENT_LIST } from '../../../../shared/native-chat-agent-support'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'

/** Names the agents behind the "supported agent" wording in the Chat UI setting —
 *  without it, users on an unsupported agent read the terminal fallback as a bug. */
export function NativeChatSupportedAgents(): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.settings.NativeChatSupportedAgents.label', 'Supported agents:')}
      </span>
      {NATIVE_CHAT_SUPPORTED_AGENT_LIST.map((agent) => (
        <span
          key={agent}
          data-slot="native-chat-supported-agent"
          data-agent={agent}
          className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 text-xs font-medium text-foreground"
        >
          <AgentIcon agent={agent} size={12} />
          {getAgentLabel(agent)}
        </span>
      ))}
    </div>
  )
}
