import type { RuntimeTerminalShow } from '../../shared/runtime-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { LinearLinkedIssueUpdatedEvent } from './runtime-linear-command-dependencies'

export type RuntimeLinearCommandPorts = {
  runtimeAvailable: () => boolean
  showTerminal: (handle: string) => Promise<RuntimeTerminalShow>
  resolveWorktreeSelector: (selector: string) => Promise<ResolvedWorktree>
  listResolvedWorktrees: () => Promise<ResolvedWorktree[]>
  setWorktreeMeta: (
    worktreeId: string,
    meta: {
      linkedLinearIssueWorkspaceId: string
      linkedLinearIssueOrganizationUrlKey: string | null
    }
  ) => void
  emitClientEvent: (event: LinearLinkedIssueUpdatedEvent) => void
}

export class RuntimeLinearCommandBase {
  constructor(private readonly ports: RuntimeLinearCommandPorts) {}

  protected runtimeAvailable(): boolean {
    return this.ports.runtimeAvailable()
  }

  protected showTerminal(handle: string): Promise<RuntimeTerminalShow> {
    return this.ports.showTerminal(handle)
  }

  protected resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree> {
    return this.ports.resolveWorktreeSelector(selector)
  }

  protected listResolvedWorktrees(): Promise<ResolvedWorktree[]> {
    return this.ports.listResolvedWorktrees()
  }

  protected setWorktreeMeta(
    worktreeId: string,
    meta: {
      linkedLinearIssueWorkspaceId: string
      linkedLinearIssueOrganizationUrlKey: string | null
    }
  ): void {
    this.ports.setWorktreeMeta(worktreeId, meta)
  }

  protected emitClientEvent(event: LinearLinkedIssueUpdatedEvent): void {
    this.ports.emitClientEvent(event)
  }
}
