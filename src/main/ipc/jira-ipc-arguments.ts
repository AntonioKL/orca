import type { JiraCreateIssueArgs } from '../../shared/jira-types'

export function normalizeTrimmedArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// IPC args are untrusted, so a malformed key list must read as "nothing declared"
// rather than reaching the resolver and widening what it rewrites.
function normalizeFieldKeyList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const keys = value.filter(
    (key): key is string => typeof key === 'string' && key.trim().length > 0
  )
  return keys.length > 0 ? keys : undefined
}

export function normalizeJiraCreateIssueArgs(
  args: JiraCreateIssueArgs
): { ok: true; args: JiraCreateIssueArgs } | { ok: false; error: string } {
  const projectId = normalizeTrimmedArg(args?.projectId)
  if (!projectId) {
    return { ok: false, error: 'Project is required.' }
  }
  const issueTypeId = normalizeTrimmedArg(args.issueTypeId)
  if (!issueTypeId) {
    return { ok: false, error: 'Issue type is required.' }
  }
  const title = normalizeTrimmedArg(args.title)
  if (!title) {
    return { ok: false, error: 'Title is required.' }
  }
  return {
    ok: true,
    args: {
      siteId: normalizeTrimmedArg(args.siteId),
      projectId,
      issueTypeId,
      title,
      description: args.description?.trim() || undefined,
      customFields:
        args.customFields && typeof args.customFields === 'object' ? args.customFields : undefined,
      userFieldKeys: normalizeFieldKeyList(args.userFieldKeys)
    }
  }
}
