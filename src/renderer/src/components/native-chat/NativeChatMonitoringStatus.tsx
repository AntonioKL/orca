import { AgentStateDot } from '@/components/AgentStateDot'
import { translate } from '@/i18n/i18n'

export function NativeChatMonitoringStatus({
  monitoring
}: {
  monitoring: boolean
}): React.JSX.Element | null {
  if (!monitoring) {
    return null
  }

  return (
    <div
      data-native-chat-monitoring-status="true"
      className="mx-auto flex w-full max-w-4xl items-center gap-1.5 px-4 py-1.5 text-xs text-muted-foreground"
      role="status"
    >
      <span aria-hidden="true">
        <AgentStateDot state="monitoring" title={null} />
      </span>
      <span>
        {translate('components.native-chat.monitoringStatus.label', 'Monitoring background tasks')}
      </span>
    </div>
  )
}
