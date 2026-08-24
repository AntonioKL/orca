import type { GitLabIssueFilter, GitLabTaskFilter } from '@/components/task-page-localized-options'

// Why: keyed records so adding a filter value fails the build instead of silently dropping it.
const GITLAB_MR_FILTERS: Record<GitLabTaskFilter, true> = {
  opened: true,
  merged: true,
  closed: true,
  all: true
}

const GITLAB_ISSUE_FILTERS: Record<GitLabIssueFilter, true> = {
  opened: true,
  'assigned-to-me': true
}

export function isGitLabMRFilter(
  value: GitLabTaskFilter | GitLabIssueFilter
): value is GitLabTaskFilter {
  return value in GITLAB_MR_FILTERS
}

export function isGitLabIssueFilter(
  value: GitLabTaskFilter | GitLabIssueFilter
): value is GitLabIssueFilter {
  return value in GITLAB_ISSUE_FILTERS
}
