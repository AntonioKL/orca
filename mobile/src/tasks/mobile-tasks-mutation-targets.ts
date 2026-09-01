import type {
  HostTaskGitHubItemTarget,
  HostTaskGitLabItemTarget,
  HostTaskItemMutationTarget,
  HostTaskLinearTarget,
  HostTaskProjectItemTarget
} from './mobile-tasks-dependencies'
import type { GitHubProjectRow } from './mobile-tasks-view-state-types'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
import { projectRowType, splitRepositorySlug } from './mobile-tasks-item-mapping'

export function projectRowMutationTarget(
  row: GitHubProjectRow,
  host: string
): HostTaskProjectItemTarget | null {
  const slug = splitRepositorySlug(row.content.repository)
  const type = projectRowType(row)
  return slug && type && row.content.number
    ? { ...slug, host, number: row.content.number, type, targetId: row.targetId }
    : null
}

export function taskItemMutationTarget(
  item: Extract<TaskItem, { provider: 'github' }>
): HostTaskGitHubItemTarget
export function taskItemMutationTarget(
  item: Extract<TaskItem, { provider: 'gitlab' }>
): HostTaskGitLabItemTarget
export function taskItemMutationTarget(
  item: Extract<TaskItem, { provider: 'github' | 'gitlab' }>
): HostTaskItemMutationTarget
export function taskItemMutationTarget(
  item: Extract<TaskItem, { provider: 'github' | 'gitlab' }>
): HostTaskItemMutationTarget {
  return item.provider === 'github'
    ? {
        provider: 'github',
        repoId: item.source.repoId,
        number: item.source.number,
        type: item.source.type,
        targetId: item.source.targetId
      }
    : {
        provider: 'gitlab',
        repoId: item.source.repoId,
        number: item.source.number,
        type: item.source.type,
        projectRef: item.source.projectRef,
        targetId: item.source.targetId
      }
}

export function taskLinearTarget(
  item: Extract<TaskItem, { provider: 'linear' }>
): HostTaskLinearTarget {
  return {
    issueId: item.source.id,
    workspaceId: item.source.workspaceId,
    teamId: item.source.team.id,
    projectId: item.source.project?.id,
    targetId: item.source.targetId
  }
}
