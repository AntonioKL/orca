import { toast } from 'sonner'
import type { TuiAgent } from '../../../shared/tui-agent'

type ProxySettings = { httpProxyUrl?: string }

/** Explain the app-level proxy context before a Claude process makes its first request. */
export function warnIfConfiguredClaudeProxy(
  agent: TuiAgent,
  settings: ProxySettings | null | undefined
): void {
  if (agent !== 'claude' || !settings?.httpProxyUrl?.trim()) {
    return
  }
  toast.warning(
    'Orca network proxy is configured for this Claude launch; the target host is routed through it unless covered by its bypass rules. If Claude reports ConnectionRefused, check Settings → Advanced → Network.',
    { duration: 12_000 }
  )
}
