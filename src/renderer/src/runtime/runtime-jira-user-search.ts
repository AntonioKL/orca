import type { JiraUser, JiraUserSearchArgs, JiraUserSearchResult } from '../../../shared/jira-types'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from './runtime-rpc-client'
import { isRuntimeProviderSearchQueryWithinLimit } from './runtime-provider-search-bounds'
import { getJiraRuntimeTarget, type RuntimeJiraSettings } from './runtime-jira-target'

function unexpectedJiraUserSearchResponse(): JiraUserSearchResult {
  return {
    ok: false,
    error: translate(
      'auto.runtime.runtime.jira.user.search.unexpectedResponse',
      'Jira user search returned an unexpected response.'
    )
  }
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

// The picker keys rows by accountId and labels them by displayName, so an entry
// missing either is a row that renders blank or selects nothing. The rows come
// from a Jira site we do not control, across Cloud and Server/DC and across
// versions, so each one is checked rather than cast.
function decodeJiraUser(value: unknown): JiraUser | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const candidate = value as { [K in keyof JiraUser]?: unknown }
  const accountId = nonBlankString(candidate.accountId)
  const displayName = nonBlankString(candidate.displayName)
  if (!accountId || !displayName) {
    return undefined
  }
  // Jira omits these or sends email as null when the directory hides it; any
  // other shape means we are not reading the payload we think we are.
  if (candidate.email !== undefined && candidate.email !== null) {
    if (typeof candidate.email !== 'string') {
      return undefined
    }
  }
  if (candidate.avatarUrl !== undefined && typeof candidate.avatarUrl !== 'string') {
    return undefined
  }
  return {
    accountId,
    displayName,
    email: candidate.email as string | null | undefined,
    avatarUrl: candidate.avatarUrl as string | undefined
  }
}

// Runtime RPC results are cast, never decoded, so an unrecognized payload (an
// older host, a shape change) must read as a failed search rather than an empty
// one — an empty dropdown is what this picker exists to stop lying about.
function normalizeJiraUserSearchResult(value: unknown): JiraUserSearchResult {
  if (typeof value === 'object' && value !== null) {
    const candidate = value as { ok?: unknown; users?: unknown; error?: unknown }
    if (candidate.ok === true && Array.isArray(candidate.users)) {
      const users: JiraUser[] = []
      for (const entry of candidate.users) {
        const user = decodeJiraUser(entry)
        // One unreadable row fails the whole search. Filtering would hand back a
        // short list that looks like the site's full answer, which is the same
        // lie as the empty dropdown, and the error path still lets the user paste
        // an account id the search never surfaced.
        if (!user) {
          return unexpectedJiraUserSearchResponse()
        }
        users.push(user)
      }
      return { ok: true, users }
    }
    if (candidate.ok === false && typeof candidate.error === 'string' && candidate.error) {
      return { ok: false, error: candidate.error }
    }
  }
  return unexpectedJiraUserSearchResponse()
}

export async function jiraSearchUsers(
  settings: RuntimeJiraSettings,
  args: JiraUserSearchArgs
): Promise<JiraUserSearchResult> {
  if (!isRuntimeProviderSearchQueryWithinLimit(args.query)) {
    return {
      ok: false,
      error: translate(
        'auto.runtime.runtime.jira.user.search.queryTooLong',
        'Search text is too long.'
      )
    }
  }
  const target = getJiraRuntimeTarget(settings)
  try {
    const result =
      target.kind === 'environment'
        ? await callRuntimeRpc<unknown>(target, 'jira.searchUsers', args, { timeoutMs: 30_000 })
        : await window.api.jira.searchUsers(args)
    return normalizeJiraUserSearchResult(result)
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : translate(
              'auto.runtime.runtime.jira.user.search.failed',
              'Failed to search Jira users.'
            )
    }
  }
}
