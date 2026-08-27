import { NATIVE_CHAT_SUPPORTED_AGENT_LIST } from '../../../../shared/native-chat-agent-support'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'

/** Names the agents so unsupported-agent terminal fallback does not look broken. */
export function NativeChatSupportedAgents(): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.settings.NativeChatSupportedAgents.label', 'Supported agents:')}
      </span>
      {NATIVE_CHAT_SUPPORTED_AGENT_LIST.map((agent) => (
        <Badge
          key={agent}
          data-agent={agent}
          variant="outline"
          className="border-border/60 bg-muted/20"
        >
          <AgentIcon agent={agent} size={12} />
          {getAgentLabel(agent)}
        </Badge>
      ))}
    </div>
  )
}
