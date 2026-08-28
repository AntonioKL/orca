/** Minimal session-tab shape needed to tell an agent session from a plain shell. */
export type AgentSendKeyboardDismissalTab = {
  readonly type: string
  readonly agentStatus?: { readonly agentType?: string | null } | null
  readonly launchAgent?: string | null
}

/** Whether a send from this tab should drop the software keyboard.
 *
 *  Why: sending to an agent hands the turn over, and the keyboard hides the
 *  reply the user is now waiting on. A plain shell keeps it — commands come in
 *  bursts, and re-opening the keyboard between each one costs more than the
 *  covered rows. `launchAgent` counts before the first agent-status update
 *  lands, so the very first prompt of a session already dismisses. */
export function shouldDismissKeyboardAfterTerminalSend(
  tab: AgentSendKeyboardDismissalTab | null | undefined
): boolean {
  if (!tab || tab.type !== 'terminal') {
    return false
  }
  const agent = tab.agentStatus?.agentType ?? tab.launchAgent ?? null
  return typeof agent === 'string' && agent.trim().length > 0
}
