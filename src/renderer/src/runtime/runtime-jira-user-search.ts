import type { JiraUser, JiraUserSearchArgs, JiraUserSearchResult } from '../../../shared/jira-types'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from './runtime-rpc-client'
import { isRuntimeProviderSearchQueryWithinLimit } from './runtime-provider-search-bounds'
import { getJiraRuntimeTarget, type RuntimeJiraSettings } from './runtime-jira-target'

// Runtime RPC results are cast, never decoded, so an unrecognized payload (an
// older host, a shape change) must read as a failed search rather than an empty
// one — an empty dropdown is what this picker exists to stop lying about.
function normalizeJiraUserSearchResult(value: unknown): JiraUserSearchResult {
  if (typeof value === 'object' && value !== null) {
    const candidate = value as { ok?: unknown; users?: unknown; error?: unknown }
    if (candidate.ok === true && Array.isArray(candidate.users)) {
      return { ok: true, users: candidate.users as JiraUser[] }
    }
    if (candidate.ok === false && typeof candidate.error === 'string' && candidate.error) {
      return { ok: false, error: candidate.error }
    }
  }
  return {
    ok: false,
    error: translate(
      'auto.runtime.runtime.jira.user.search.unexpectedResponse',
      'Jira user search returned an unexpected response.'
    )
  }
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
