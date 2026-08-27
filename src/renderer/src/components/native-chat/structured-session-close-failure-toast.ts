import { toast } from 'sonner'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { agentSessionProviderLabel } from '../../../../shared/agent-session-provider-label'
import { translate } from '@/i18n/i18n'

/**
 * Why: every close path used to name Codex outright, so a failed Claude close told the user the
 * wrong provider. A tab that carries no agent — an older persisted row whose optional field was
 * dropped — stays unnamed rather than guessing.
 */
export function reportStructuredSessionCloseFailure(input: {
  agent: unknown
  description: string
}): void {
  const provider = isAgentSessionHandleProvider(input.agent) ? input.agent : null
  toast.error(
    provider
      ? translate(
          'components.native-chat.structuredSessionCloseFailed',
          'Could not close this {{providerLabel}} chat',
          { providerLabel: agentSessionProviderLabel(provider) }
        )
      : translate(
          'components.native-chat.structuredSessionCloseFailedUnknownProvider',
          'Could not close this chat'
        ),
    { description: input.description }
  )
}
