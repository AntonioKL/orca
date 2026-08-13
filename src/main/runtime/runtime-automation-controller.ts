import type { AutomationService } from '../automations/service'
import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationUpdateInput,
  AutomationWorkspaceMode
} from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import type { RuntimeStore } from './runtime-store-contract'

export type RuntimeAutomationCreateInput = Omit<
  AutomationCreateInput,
  'projectId' | 'workspaceId' | 'workspaceMode' | 'timezone'
> & {
  repo?: string
  workspace?: string
  workspaceMode?: AutomationWorkspaceMode
  timezone?: string
}

export type RuntimeAutomationUpdateInput = Omit<
  AutomationUpdateInput,
  'projectId' | 'workspaceId'
> & {
  repo?: string
  workspace?: string
}

type RuntimeAutomationTargetResolvers = {
  showRepo: (selector: string) => Promise<Repo>
  showManagedWorktree: (selector: string) => Promise<Pick<Worktree, 'id' | 'repoId'>>
}

export class RuntimeAutomationController {
  private service: AutomationService | null = null

  constructor(
    private readonly store: RuntimeStore | null,
    private readonly resolvers: RuntimeAutomationTargetResolvers
  ) {}

  setService(service: AutomationService): void {
    this.service = service
  }

  list(): Automation[] {
    if (!this.store?.listAutomations) {
      throw new Error('runtime_unavailable')
    }
    return this.store.listAutomations()
  }

  listRuns(automationId?: string): AutomationRun[] {
    if (!this.store?.listAutomationRuns) {
      throw new Error('runtime_unavailable')
    }
    return this.store.listAutomationRuns(automationId)
  }

  show(id: string): Automation {
    const automation = this.list().find((entry) => entry.id === id)
    if (!automation) {
      throw new Error('Automation not found.')
    }
    return automation
  }

  async create(input: RuntimeAutomationCreateInput): Promise<Automation> {
    if (!this.store?.createAutomation) {
      throw new Error('runtime_unavailable')
    }
    const target = await this.resolveTarget(input)
    if (input.reuseSession && target.workspaceMode !== 'existing') {
      throw new Error('Session reuse requires an existing workspace target.')
    }
    return this.store.createAutomation({
      name: input.name,
      prompt: input.prompt,
      precheck: input.precheck,
      agentId: input.agentId,
      runContext: input.runContext,
      sourceContext: input.sourceContext,
      projectId: target.projectId,
      workspaceMode: target.workspaceMode,
      workspaceId: target.workspaceId,
      baseBranch: input.baseBranch,
      setupDecision: input.setupDecision,
      reuseSession: input.reuseSession,
      timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      rrule: input.rrule,
      dtstart: input.dtstart,
      enabled: input.enabled,
      missedRunGraceMinutes: input.missedRunGraceMinutes
    })
  }

  async update(id: string, updates: RuntimeAutomationUpdateInput): Promise<Automation> {
    if (!this.store?.updateAutomation) {
      throw new Error('runtime_unavailable')
    }
    const current = this.show(id)
    const patch: AutomationUpdateInput = {}
    this.copyPatchValues(updates, patch)
    const targetChanged =
      hasUpdateValue(updates, 'repo') ||
      hasUpdateValue(updates, 'workspace') ||
      hasUpdateValue(updates, 'workspaceMode')
    if (targetChanged) {
      const target = await this.resolveTarget(updates, current)
      if (patch.reuseSession === true && target.workspaceMode !== 'existing') {
        throw new Error('Session reuse requires an existing workspace target.')
      }
      patch.projectId = target.projectId
      patch.workspaceMode = target.workspaceMode
      patch.workspaceId = target.workspaceId
      if (target.workspaceMode !== 'existing') {
        patch.reuseSession = false
      }
    }
    if (!targetChanged && patch.reuseSession && current.workspaceMode !== 'existing') {
      throw new Error('Session reuse requires an existing workspace target.')
    }
    return this.store.updateAutomation(id, patch)
  }

  delete(id: string): { removed: boolean; id: string } {
    if (!this.store?.deleteAutomation) {
      throw new Error('runtime_unavailable')
    }
    this.show(id)
    this.store.deleteAutomation(id)
    return { removed: true, id }
  }

  async runNow(id: string): Promise<AutomationRun> {
    if (!this.service) {
      throw new Error('runtime_unavailable')
    }
    return await this.service.runNow(id)
  }

  private copyPatchValues(
    updates: RuntimeAutomationUpdateInput,
    patch: AutomationUpdateInput
  ): void {
    const keys = [
      'name',
      'prompt',
      'precheck',
      'agentId',
      'runContext',
      'sourceContext',
      'baseBranch',
      'setupDecision',
      'reuseSession',
      'timezone',
      'rrule',
      'dtstart',
      'enabled',
      'missedRunGraceMinutes'
    ] as const
    for (const key of keys) {
      if (hasUpdateValue(updates, key)) {
        Object.assign(patch, { [key]: updates[key] })
      }
    }
  }

  private async resolveTarget(
    input: {
      repo?: string
      workspace?: string
      workspaceMode?: AutomationWorkspaceMode
      baseBranch?: string | null
    },
    current?: Automation
  ): Promise<{
    projectId: string
    workspaceMode: AutomationWorkspaceMode
    workspaceId?: string | null
  }> {
    const hasRepo = input.repo !== undefined
    const hasWorkspace = input.workspace !== undefined
    if (
      current?.workspaceMode === 'existing' &&
      hasRepo &&
      !hasWorkspace &&
      input.workspaceMode !== 'new_per_run'
    ) {
      throw new Error(
        'Repo updates for existing-workspace automation require workspaceMode new_per_run.'
      )
    }
    const workspace = input.workspace
      ? await this.resolvers.showManagedWorktree(input.workspace)
      : null
    const repo = input.repo ? await this.resolvers.showRepo(input.repo) : null
    const workspaceMode =
      input.workspaceMode ??
      (workspace
        ? 'existing'
        : input.repo && !current
          ? 'new_per_run'
          : (current?.workspaceMode ?? 'new_per_run'))
    if (workspaceMode === 'existing') {
      const workspaceId = workspace?.id ?? current?.workspaceId
      const projectId = workspace?.repoId ?? current?.projectId
      if (repo && repo.id !== projectId) {
        throw new Error('Selected workspace belongs to a different repo.')
      }
      if (!workspaceId || !projectId) {
        throw new Error('Existing-workspace automation requires --workspace.')
      }
      return { projectId, workspaceMode, workspaceId }
    }
    const projectId = repo?.id ?? workspace?.repoId ?? current?.projectId
    if (!projectId) {
      throw new Error('Automation requires --repo or --workspace.')
    }
    return { projectId, workspaceMode: 'new_per_run', workspaceId: null }
  }
}

function hasUpdateValue<K extends keyof RuntimeAutomationUpdateInput>(
  updates: RuntimeAutomationUpdateInput,
  key: K
): boolean {
  return Object.hasOwn(updates, key) && updates[key] !== undefined
}
