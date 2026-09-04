import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  getTuiAgentDefaultArgs,
  getTuiAgentDefaultEnv
} from '../../../shared/tui-agent-launch-defaults'
import {
  decideInitialAgentTabViewMode,
  type NativeChatLaunchPromptDelivery
} from '@/lib/native-chat-initial-view-mode'

export type AgentLaunchRoute = 'structured-native-chat' | 'legacy-native-chat' | 'terminal-tui'

export type AgentLaunchRoutingInput = {
  agent: TuiAgent
  settings:
    | Pick<
        GlobalSettings,
        | 'experimentalNativeChat'
        | 'experimentalStructuredNativeChat'
        | 'openAgentTabsInChatByDefault'
      >
    | null
    | undefined
  executionHostId: string
  platform: NodeJS.Platform
  hostCapabilities: readonly string[]
  /** Whether the host PROVED its process table exposes creation times, which is
   *  what makes Windows PID ownership decidable. Required (not optional) so a
   *  new call site cannot silently disable Windows by omitting it; 'unknown'
   *  is refused so a recycled PID can never be adopted. */
  windowsProcessStartTime: 'available' | 'unavailable' | 'unknown'
  /** Whether the workspace resolves through a WSL UNC path, which belongs to
   *  the distro's runtime and must keep the legacy terminal. Required for the
   *  same reason. */
  worktreeUsesWslPath: boolean
  /** True when this renderer is a paired web client. Its `platform` then
   *  describes the browser's machine, not the host that will run the agent, so
   *  the Windows gate below cannot be evaluated and must refuse rather than
   *  guess. Lifting this needs host-published eligibility, not a client probe. */
  isWebClient: boolean
  workspaceKind?: 'git-worktree' | 'folder' | 'floating'
  projectRuntime?: ProjectExecutionRuntimeResolution | null
  promptDelivery?: NativeChatLaunchPromptDelivery
  launchText?: string
  nativeChatTranscriptIsLocalReadable?: boolean
  requiresTuiLaunchCustomization?: boolean
  initialSessionOptions?: Readonly<Record<string, unknown>>
}

export function hasExplicitTuiLaunchCustomization(
  settings:
    | Pick<GlobalSettings, 'agentCmdOverrides' | 'agentDefaultArgs' | 'agentDefaultEnv'>
    | null
    | undefined,
  agent: TuiAgent
): boolean {
  const configuredArgs = settings?.agentDefaultArgs?.[agent]
  const configuredEnv = settings?.agentDefaultEnv?.[agent]
  const defaultEnv = getTuiAgentDefaultEnv(agent)
  const envIsCustomized =
    configuredEnv !== undefined &&
    (Object.keys(configuredEnv).length !== Object.keys(defaultEnv).length ||
      Object.entries(configuredEnv).some(([key, value]) => defaultEnv[key] !== value))
  return (
    Boolean(settings?.agentCmdOverrides?.[agent]?.trim()) ||
    hasExplicitTuiAgentArgs(agent, configuredArgs) ||
    envIsCustomized
  )
}

export function hasSemanticallyNonEmptyAgentArgs(value: string | null | undefined): boolean {
  return Boolean(value?.trim())
}

export function hasExplicitTuiAgentArgs(
  agent: TuiAgent,
  value: string | null | undefined
): boolean {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 && trimmed !== getTuiAgentDefaultArgs(agent).trim()
}

export function resolveAgentLaunchRoute(input: AgentLaunchRoutingInput): AgentLaunchRoute {
  const initialViewMode = decideInitialAgentTabViewMode({
    experimentalNativeChat: input.settings?.experimentalNativeChat,
    openAgentTabsInChatByDefault: input.settings?.openAgentTabsInChatByDefault,
    agent: input.agent,
    promptDelivery: input.promptDelivery,
    launchDraftText: input.launchText,
    nativeChatTranscriptIsLocalReadable: input.nativeChatTranscriptIsLocalReadable
  })
  if (initialViewMode !== 'chat') {
    return 'terminal-tui'
  }
  if (input.settings?.experimentalStructuredNativeChat !== true) {
    return 'legacy-native-chat'
  }

  const projectRuntime = input.projectRuntime
  const runtimeRefused =
    projectRuntime?.status === 'repair-required' || projectRuntime?.runtime.kind === 'wsl'
  const hasInitialSessionOptions = Boolean(
    input.initialSessionOptions && Object.keys(input.initialSessionOptions).length > 0
  )
  // Windows structured ownership is safe only once the host proved it can read
  // process creation times; a WSL UNC workspace stays on the legacy terminal.
  const windowsStructuredAllowed =
    input.platform !== 'win32' ||
    (input.windowsProcessStartTime === 'available' && !input.worktreeUsesWslPath)
  const structuredSupported =
    !input.isWebClient &&
    input.agent === 'codex' &&
    input.promptDelivery !== 'draft' &&
    input.workspaceKind !== 'floating' &&
    input.requiresTuiLaunchCustomization !== true &&
    !hasInitialSessionOptions &&
    input.executionHostId === 'local' &&
    windowsStructuredAllowed &&
    !runtimeRefused &&
    input.hostCapabilities.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)

  return structuredSupported ? 'structured-native-chat' : 'legacy-native-chat'
}
