import type { JiraAuthType } from './jira-types'

// A user-typed Jira create field (reporter, assignee, custom user pickers) never
// travels as a bare string: Jira rejects that shape. The renderer emits this
// provider-neutral marker and the execution host resolves it against the site,
// because only the host knows whether the site is Cloud (accountId) or
// Server/DC (username).
export type JiraUserFieldValue = { accountId: string }

export function buildJiraUserFieldValue(accountId: string): JiraUserFieldValue | undefined {
  const trimmed = accountId.trim()
  return trimmed ? { accountId: trimmed } : undefined
}

export function isJiraUserFieldValue(value: unknown): value is JiraUserFieldValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const accountId = (value as { accountId?: unknown }).accountId
  return typeof accountId === 'string' && accountId.trim().length > 0
}

// Cloud identifies users by accountId (`id`); Server/DC has no accountId and
// identifies them by username (`name`) — the same split updateIssue makes when
// assigning.
export function resolveJiraUserFieldValue(
  value: JiraUserFieldValue,
  authType: JiraAuthType | undefined
): { id: string } | { name: string } {
  const accountId = value.accountId.trim()
  return authType === 'server' ? { name: accountId } : { id: accountId }
}

// Only a field Jira declared as a user field is rewritten. The marker is a shape,
// not a type, so a lookalike object on an undeclared key would otherwise be
// silently retyped on its way to Jira; undeclared means unknown, and unknown is
// left exactly as it arrived.
export function resolveJiraCreateFieldValue(
  fieldKey: string,
  value: unknown,
  userFieldKeys: ReadonlySet<string>,
  authType: JiraAuthType | undefined
): unknown {
  return userFieldKeys.has(fieldKey) ? resolveJiraUserFieldValues(value, authType) : value
}

// Leaves every non-user value untouched so other providers' and Jira's own
// option/number/text fields keep flowing through unchanged.
export function resolveJiraUserFieldValues(
  value: unknown,
  authType: JiraAuthType | undefined
): unknown {
  if (isJiraUserFieldValue(value)) {
    return resolveJiraUserFieldValue(value, authType)
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveJiraUserFieldValues(entry, authType))
  }
  return value
}
