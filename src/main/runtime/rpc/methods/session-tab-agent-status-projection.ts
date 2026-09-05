import {
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/runtime-types'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import { structuredNativeChatProjectionEnabled } from './structured-agent-session-policy'

type SessionTabsPayload = RuntimeMobileSessionTabsResult | RuntimeMobileSessionTabsSnapshot

/** Capped at 128px / one line in every shipped mobile build, so ~15-18 characters render. */
export const STRUCTURED_CHAT_UPDATE_REQUIRED_TAB_TITLE = 'Update to view'

/** Which structured tabs a mobile client should be shown as an update prompt instead of the real
 *  chat, or null when this client is not owed one. Keyed on the capability for THAT agent: a build
 *  that cannot render the chat gets a row telling it to update, because a later build can. */
function resolveMobileUpdatePromptScope(args: {
  clientKind: 'mobile' | 'runtime' | undefined
  clientCapabilities: readonly RuntimeCapability[] | undefined
  structuredNativeChatEnabled?: boolean
}): ((tab: RuntimeMobileSessionAgentTab) => boolean) | null {
  if (args.clientKind !== 'mobile') {
    return null
  }
  // Why: with the experiment off there is no chat to reach after updating, so the prompt would lie.
  if (args.structuredNativeChatEnabled !== true) {
    return null
  }
  if (!args.clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)) {
    return () => true
  }
  if (!args.clientCapabilities.includes(CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)) {
    return (tab) => tab.agent !== 'codex'
  }
  return null
}

export function projectSessionTabAgentStatus<TPayload extends SessionTabsPayload>(
  payload: TPayload,
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: readonly RuntimeCapability[] | undefined,
  structuredNativeChatEnabled?: boolean
): TPayload {
  const structuredVisible = structuredNativeChatProjectionEnabled({
    clientKind,
    clientCapabilities,
    structuredNativeChatEnabled
  })
  const updatePromptScope = resolveMobileUpdatePromptScope({
    clientKind,
    clientCapabilities,
    structuredNativeChatEnabled
  })
  let projected: TPayload
  if (updatePromptScope) {
    // Why: deleting the row left the user hunting for a chat the desktop says exists; the row
    // survives with a title naming the fix. Nothing is removed, so no group/layout repair applies.
    projected = promptAgentSessionTabsToUpdate(payload, updatePromptScope)
  } else {
    projected = structuredVisible ? payload : projectAgentSessionTabsOut(payload, () => true)
    // Why: a paired client renders only codex structured tabs unless it says otherwise
    // (mobile's resolveMobileNativeChat returns null for every other agent), so an
    // ungated row would list and select into a pane that shows neither chat nor terminal.
    if (
      structuredVisible &&
      clientKind !== undefined &&
      !clientCapabilities?.includes(CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    ) {
      projected = projectAgentSessionTabsOut(projected, (tab) => tab.agent !== 'codex')
    }
  }
  // Why: only paired runtimes have legacy `done` completion side effects; mobile must keep its row without changing the exact v2 auth shape.
  if (
    clientKind !== 'runtime' ||
    clientCapabilities?.includes(AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY)
  ) {
    return projected
  }

  let changed = false
  const tabs = projected.tabs.map((tab) => {
    if (tab.type !== 'terminal' || !tab.agentStatus?.sessionBoundary) {
      return tab
    }
    changed = true
    const { agentStatus: _boundary, ...legacyTab } = tab
    return legacyTab
  })
  return changed ? ({ ...projected, tabs } as TPayload) : projected
}

function promptAgentSessionTabsToUpdate<TPayload extends SessionTabsPayload>(
  payload: TPayload,
  shouldPrompt: (tab: RuntimeMobileSessionAgentTab) => boolean
): TPayload {
  let changed = false
  const tabs = payload.tabs.map((tab) => {
    if (tab.type !== 'agent-session' || !shouldPrompt(tab)) {
      return tab
    }
    changed = true
    return { ...tab, title: STRUCTURED_CHAT_UPDATE_REQUIRED_TAB_TITLE }
  })
  return changed ? ({ ...payload, tabs } as TPayload) : payload
}

function projectAgentSessionTabsOut<TPayload extends SessionTabsPayload>(
  payload: TPayload,
  shouldHide: (tab: RuntimeMobileSessionAgentTab) => boolean
): TPayload {
  const hiddenIds = new Set(
    payload.tabs
      .filter(
        (tab): tab is RuntimeMobileSessionAgentTab =>
          tab.type === 'agent-session' && shouldHide(tab)
      )
      .map((tab) => tab.id)
  )
  if (hiddenIds.size === 0) {
    return payload
  }
  const tabs = payload.tabs.filter((tab) => !hiddenIds.has(tab.id))
  const groups = payload.tabGroups
    ?.map((group) => {
      const tabOrder = group.tabOrder.filter((id) => !hiddenIds.has(id))
      if (tabOrder.length === 0) {
        return null
      }
      const recentTabIds = group.recentTabIds?.filter((id) => !hiddenIds.has(id))
      return {
        ...group,
        activeTabId:
          group.activeTabId && tabOrder.includes(group.activeTabId)
            ? group.activeTabId
            : (recentTabIds?.find((id) => tabOrder.includes(id)) ?? tabOrder[0] ?? null),
        tabOrder,
        ...(recentTabIds ? { recentTabIds } : {})
      }
    })
    .filter((group): group is NonNullable<typeof group> => group !== null)
  const active =
    tabs.find((tab) => tab.id === payload.activeTabId) ??
    tabs.find((tab) => tab.isActive) ??
    tabs[0] ??
    null
  const validGroupIds = new Set(groups?.map((group) => group.id) ?? [])
  return {
    ...payload,
    activeGroupId:
      groups?.find((group) => group.tabOrder.includes(active?.id ?? ''))?.id ??
      groups?.[0]?.id ??
      null,
    activeTabId: active?.id ?? null,
    activeTabType: active?.type ?? null,
    ...(groups ? { tabGroups: groups } : { tabGroups: undefined }),
    ...(payload.tabGroupLayout !== undefined
      ? { tabGroupLayout: pruneStructuredTabGroupLayout(payload.tabGroupLayout, validGroupIds) }
      : {}),
    tabs: tabs.map((tab) => ({ ...tab, isActive: tab.id === active?.id }))
  } as TPayload
}

function pruneStructuredTabGroupLayout(
  layout: TabGroupLayoutNode | null,
  validGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | null {
  if (!layout || layout.type === 'leaf') {
    return layout && validGroupIds.has(layout.groupId) ? layout : null
  }
  const first = pruneStructuredTabGroupLayout(layout.first, validGroupIds)
  const second = pruneStructuredTabGroupLayout(layout.second, validGroupIds)
  return first && second ? { ...layout, first, second } : (first ?? second)
}
