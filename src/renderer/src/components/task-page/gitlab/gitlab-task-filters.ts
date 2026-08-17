import type { GitLabIssueFilter, GitLabTaskFilter } from '@/components/task-page-localized-options'

export function isGitLabMRFilter(
  value: GitLabTaskFilter | GitLabIssueFilter
): value is GitLabTaskFilter {
  return value === 'opened' || value === 'merged' || value === 'closed' || value === 'all'
}

export function isGitLabIssueFilter(
  value: GitLabTaskFilter | GitLabIssueFilter
): value is GitLabIssueFilter {
  return value === 'opened' || value === 'assigned-to-me'
}
