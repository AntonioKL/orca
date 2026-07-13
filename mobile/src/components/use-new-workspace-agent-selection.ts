import { useState } from 'react'
import {
  buildSelectableNewWorktreeAgentOptions,
  NEW_WORKTREE_AGENT_OPTIONS,
  NEW_WORKTREE_BLANK_AGENT,
  resolveNewWorktreeAgentSelection,
  type NewWorktreeAgentOption,
  type NewWorktreeRuntimeSettings
} from './new-worktree-agent-selection'
import type { AgentCatalogValue } from '../transport/agent-catalog-sync'

export function useNewWorkspaceAgentSelection(args: {
  visible: boolean
  runtimeSettings: NewWorktreeRuntimeSettings | null
  detectedAgentIds: Set<string> | null
  agentCatalog: AgentCatalogValue | null
}): {
  selectedAgent: NewWorktreeAgentOption
  setSelectedAgent: (agent: NewWorktreeAgentOption) => void
  setAgentOverridden: (overridden: boolean) => void
  agentOverridden: boolean
  pickerAgentOptions: NewWorktreeAgentOption[]
} {
  const [selectedAgentState, setSelectedAgent] = useState<NewWorktreeAgentOption>(
    NEW_WORKTREE_AGENT_OPTIONS[0]!
  )
  const [agentOverriddenState, setAgentOverridden] = useState(false)
  const resolution = resolveNewWorktreeAgentSelection({
    visible: args.visible,
    selectedAgent: selectedAgentState,
    agentOverridden: agentOverriddenState,
    runtimeSettings: args.runtimeSettings,
    detectedAgentIds: args.detectedAgentIds
  })
  if (
    selectedAgentState.id !== resolution.selectedAgent.id ||
    agentOverriddenState !== resolution.agentOverridden
  ) {
    setSelectedAgent(resolution.selectedAgent)
    setAgentOverridden(resolution.agentOverridden)
  }
  const visibleAgentOptions = buildSelectableNewWorktreeAgentOptions({
    snapshot: args.agentCatalog,
    includeCustomAgents: true,
    detectedAgentIds: args.detectedAgentIds,
    disabledTuiAgents: args.runtimeSettings?.disabledTuiAgents
  })
  return {
    selectedAgent: resolution.selectedAgent,
    setSelectedAgent,
    setAgentOverridden,
    agentOverridden: resolution.agentOverridden,
    pickerAgentOptions: [...visibleAgentOptions, NEW_WORKTREE_BLANK_AGENT]
  }
}
