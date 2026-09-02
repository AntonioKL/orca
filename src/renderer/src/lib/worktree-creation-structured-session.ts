import { useAppStore } from '@/store'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { activateAndRevealWorktree, type ActivateAndRevealResult } from '@/lib/worktree-activation'
import { startStructuredCodexLaunch } from '@/lib/structured-agent-session-launch'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-codex-session'
import { activateStructuredAgentSessionById } from '@/lib/structured-agent-session-tab-activation'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'

export type WorktreeCreationStructuredSessionResult = {
  accepted: boolean
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
}

export async function launchStructuredWorktreeSession(args: {
  request: WorktreeCreationRequest
  worktreeId: string
  shouldActivateOnCompletion: boolean
  fallbackStartupOpt: WorktreeStartupPayload | undefined
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
}): Promise<WorktreeCreationStructuredSessionResult> {
  let { activation, primaryTabId } = args
  let accepted = true
  if (args.request.agent !== 'codex') {
    return { accepted, activation, primaryTabId }
  }

  const launch = startStructuredCodexLaunch(args.worktreeId, {
    prompt: args.request.launchDraftPrompt ?? args.request.quickPrompt
  })
  const refusalFallback = launch.claimDefinitiveRefusalFallback(async () => {
    accepted = false
    if (args.request.pendingFirstAgentMessageRename) {
      await useAppStore
        .getState()
        .updateWorktreeMeta(args.worktreeId, { pendingFirstAgentMessageRename: true })
        .catch(() => undefined)
    }
    if (args.shouldActivateOnCompletion) {
      const fallbackActivation = activateAndRevealWorktree(args.worktreeId, {
        sidebarRevealBehavior: 'auto',
        createNewTerminalForStartup: true,
        ...(args.fallbackStartupOpt ? { startup: args.fallbackStartupOpt } : {})
      })
      activation = fallbackActivation
      primaryTabId = fallbackActivation === false ? null : fallbackActivation.primaryTabId
      return
    }
    primaryTabId = ensureWorktreeHasInitialTerminal(
      useAppStore.getState(),
      args.worktreeId,
      args.fallbackStartupOpt,
      undefined,
      undefined,
      undefined,
      { activateCreatedTabs: false, createNewTerminalForStartup: true }
    )
  })

  try {
    const receipt = await launch.launchResult
    if (args.shouldActivateOnCompletion) {
      activateStructuredAgentSessionById({
        worktreeId: args.worktreeId,
        sessionId: receipt.sessionId
      })
    }
  } catch (error) {
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      await refusalFallback
    }
  }
  return { accepted, activation, primaryTabId }
}
