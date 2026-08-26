import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { nativeChatSlashCommandOpensAgentPicker } from '../../../../shared/native-chat-slash-commands'
import {
  appendCommandMarkerCache,
  type NativeChatCommandMarker,
  type NativeChatCommandMarkerScope
} from './native-chat-command-marker'

/**
 * Everything the chat view owes a verified slash command that just went out to
 * the TUI: the local `Ran /x` marker (slash commands are never transcript
 * turns), plus revealing the terminal for the ones the agent answers with its
 * own picker.
 *
 * The reveal belongs to the view, not the composer: only the view knows the
 * chat surface is currently covering the TUI the picker draws in. Without it a
 * `/resume` looks like a command that did nothing at all (STA-4617). Session
 * options already reveal `/model` this way; this is the half that has no
 * session-option catalog behind it, so it also covers agents that have slash
 * commands but no options catalog.
 */
export function useNativeChatSlashCommandDispatched(args: {
  agent: AgentType
  commandMarkerScope: NativeChatCommandMarkerScope
  setCommandMarkers: Dispatch<SetStateAction<NativeChatCommandMarker[]>>
  onSwitchToTerminal?: () => void
}): (command: string) => void {
  const { agent, commandMarkerScope, setCommandMarkers, onSwitchToTerminal } = args
  return useCallback(
    (command: string) => {
      setCommandMarkers(appendCommandMarkerCache(commandMarkerScope, command))
      if (nativeChatSlashCommandOpensAgentPicker(command, getVerifiedNativeChatCommands(agent))) {
        onSwitchToTerminal?.()
      }
    },
    [agent, commandMarkerScope, onSwitchToTerminal, setCommandMarkers]
  )
}
