import { createHash } from 'node:crypto'
import type { AgentHookSource } from '../../shared/agent-hook-relay'

// Why: Pi/OMP auto-discover every extension file in the agent's extensions dir, and Orca
// side-loads its managed copy with `-e` whenever a user-owned file already holds that name
// (writeManagedExtension refuses to overwrite an unmarked file). Both copies then run in the
// same process and post the same pane's status, but an unmanaged copy is frozen at whatever
// Orca version produced it, so it can post a completion the managed copy deliberately withheld
// and settle a pane that is still working.
//
// Orca's managed extension stamps ORCA_AGENT_LAUNCH_TOKEN into every post body; an unmanaged
// copy predating that field cannot. That is the only reliable in-band discriminator, because
// both copies share the process, the pane key, and the endpoint credentials.

/** Panes tracked before the oldest owner is evicted; a lost owner only re-opens the gate. */
const MAX_TRACKED_PANES = 512

export type UnmanagedStatusExtensionReport = {
  paneKey: string
  source: AgentHookSource
}

export type StatusPostOrigin =
  /** Carries a launch token: this is the process Orca launched, and it now owns the pane. */
  | 'managed'
  /** No token, and a token-carrying poster is already live on the same pane and source. */
  | 'unmanaged'
  /** No token and no established owner: indistinguishable from a normal tokenless launch. */
  | 'unattributed'

/**
 * Tells Orca's own status extension apart from a second one loaded alongside it.
 *
 * Only ever classifies a *tokenless* post as unmanaged, and only once the same pane and source
 * have proven a token-carrying poster exists. A tokened post is never rejected, so a relaunch
 * always takes the pane back.
 */
export class UnmanagedStatusExtensionFence {
  private ownerHashByPaneKey = new Map<string, Map<AgentHookSource, string>>()
  private reportedSourcesByPaneKey = new Map<string, Set<AgentHookSource>>()
  private onDetected: ((report: UnmanagedStatusExtensionReport) => void) | null = null

  setDetectionListener(listener: ((report: UnmanagedStatusExtensionReport) => void) | null): void {
    this.onDetected = listener
  }

  classify(
    paneKey: string,
    source: AgentHookSource | undefined,
    launchToken: string | undefined
  ): StatusPostOrigin {
    if (!source || paneKey.length === 0) {
      return 'unattributed'
    }
    const token = launchToken?.trim() ?? ''
    if (token.length > 0) {
      this.rememberOwner(paneKey, source, createHash('sha256').update(token).digest('hex'))
      return 'managed'
    }
    if (!this.ownerHashByPaneKey.get(paneKey)?.has(source)) {
      return 'unattributed'
    }
    const reported = this.reportedSourcesByPaneKey.get(paneKey)
    if (!reported?.has(source)) {
      if (reported) {
        reported.add(source)
      } else {
        this.reportedSourcesByPaneKey.set(paneKey, new Set([source]))
      }
      this.onDetected?.({ paneKey, source })
    }
    return 'unmanaged'
  }

  /** Pane teardown: drop the owner so a key reused by a tokenless launch starts from an open gate. */
  forgetPane(paneKey: string): void {
    this.ownerHashByPaneKey.delete(paneKey)
    this.reportedSourcesByPaneKey.delete(paneKey)
  }

  private rememberOwner(paneKey: string, source: AgentHookSource, hash: string): void {
    // Why: re-insert so the Map's insertion order stays a usable LRU for the cap below.
    const existing = this.ownerHashByPaneKey.get(paneKey)
    this.ownerHashByPaneKey.delete(paneKey)
    const sources = existing ?? new Map<AgentHookSource, string>()
    sources.set(source, hash)
    this.ownerHashByPaneKey.set(paneKey, sources)
    while (this.ownerHashByPaneKey.size > MAX_TRACKED_PANES) {
      const oldest = this.ownerHashByPaneKey.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.ownerHashByPaneKey.delete(oldest)
      this.reportedSourcesByPaneKey.delete(oldest)
    }
  }
}
