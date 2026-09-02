import type { ActivityGroupBy, ThreadReadFilter } from './ui-chrome-types'

export const DEFAULT_AGENTS_READ_FILTER: ThreadReadFilter = 'all'
export const DEFAULT_AGENTS_GROUP_BY: ActivityGroupBy = 'status'

const ACTIVITY_GROUP_BY_VALUES: ReadonlySet<string> = new Set<ActivityGroupBy>([
  'none',
  'status',
  'project',
  'worktree',
  'agent'
])

export function normalizeThreadReadFilter(value: unknown): ThreadReadFilter {
  return value === 'unread' || value === 'all' ? value : DEFAULT_AGENTS_READ_FILTER
}

export function normalizeActivityGroupBy(value: unknown): ActivityGroupBy {
  return typeof value === 'string' && ACTIVITY_GROUP_BY_VALUES.has(value)
    ? (value as ActivityGroupBy)
    : DEFAULT_AGENTS_GROUP_BY
}
