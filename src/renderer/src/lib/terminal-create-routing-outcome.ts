import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { WorktreeOperationRouteResolution } from './worktree-operation-route'
import type { WebRuntimeTerminalCreateOutcome } from '@/runtime/web-runtime-session'

/**
 * `unroutable` means Orca could not pick or reach an owner for the workspace. Per
 * docs/reference/ssh-execution-boundary.md that is never evidence the host or its
 * processes ended, so the copy below stays in unknown-ownership terms.
 */
export type TerminalCreateRoutingOutcome =
  | WebRuntimeTerminalCreateOutcome
  | { status: 'unroutable'; message: string }
  | { status: 'no-active-workspace' }

export function unroutableWorkspaceOutcome(
  resolution: Exclude<WorktreeOperationRouteResolution, { kind: 'resolved' }>
): TerminalCreateRoutingOutcome {
  return {
    status: 'unroutable',
    message:
      resolution.kind === 'ambiguous'
        ? translate(
            'terminalCreation.ambiguousOwner',
            'More than one execution host claims this workspace, so Orca cannot tell where the terminal belongs. Select the workspace host explicitly, then try again.'
          )
        : translate(
            'terminalCreation.unknownOwner',
            'Orca cannot tell which execution host owns this workspace, so it has nowhere to open the terminal. The host may still be connecting or out of contact; reopen the workspace and try again.'
          )
  }
}

export function unpairedWebClientWorkspaceOutcome(): TerminalCreateRoutingOutcome {
  return {
    status: 'unroutable',
    message: translate(
      'terminalCreation.webClientNeedsPairedRuntime',
      'This workspace is not routed to a paired runtime, and the web client cannot open a terminal on the local machine. Pair its runtime or open the workspace in the Orca desktop app.'
    )
  }
}

/**
 * Agent launches share the create verdicts, so an unconfirmed one must keep the "may exist" framing:
 * a definite-failure toast invites a retry that duplicates a live agent on the same worktree.
 */
export function agentLaunchFailureMessage(
  outcome: WebRuntimeTerminalCreateOutcome,
  agentLabel: string
): string | null {
  if (outcome.status === 'created') {
    return null
  }
  const message =
    outcome.message ||
    translate(
      'auto.lib.launch.agent.in.new.tab.11cce5cc77',
      'Could not launch {{value0}} in a new terminal.',
      { value0: agentLabel }
    )
  return outcome.status === 'unverifiable'
    ? translate(
        'terminalCreation.unverifiedAgentLaunch',
        'Orca could not confirm whether {{agent}} launched in a new terminal. {{message}} Check the workspace before trying again.',
        { agent: agentLabel, message }
      )
    : message
}

/** Null for outcomes the user asked for and got, plus the benign no-active-workspace no-op. */
export function terminalCreateFailureMessage(outcome: TerminalCreateRoutingOutcome): string | null {
  if (outcome.status === 'created' || outcome.status === 'no-active-workspace') {
    return null
  }
  if (outcome.status === 'unverifiable') {
    // Why: the host may have created the PTY, so a definite-failure toast invites a duplicate retry.
    return translate(
      'terminalCreation.unverified',
      'Orca could not confirm whether the new terminal opened. {{message}} Check the workspace before trying again.',
      { message: outcome.message }
    )
  }
  return translate('terminalCreation.failed', 'Could not open a new terminal. {{message}}', {
    message: outcome.message
  })
}

export function reportTerminalCreateOutcome(outcome: TerminalCreateRoutingOutcome): void {
  const message = terminalCreateFailureMessage(outcome)
  if (message) {
    toast.error(message)
  }
}

export function reportTerminalCreateRejection(error: unknown): void {
  toast.error(
    translate('terminalCreation.failed', 'Could not open a new terminal. {{message}}', {
      message: error instanceof Error ? error.message : String(error)
    })
  )
}
