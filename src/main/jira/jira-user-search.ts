import type { JiraUser, JiraUserSearchResult } from '../../shared/jira-types'
import { acquire, release } from './request-queue'
import { apiBasePath, jiraRequest } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { mapUser } from './jira-issue-mapping'
import type { JiraRecord } from './jira-record-pages'

function buildAssignableSearchParams(
  authType: string | undefined,
  scope: { issueKey?: string; projectIdOrKey?: string },
  query?: string
): URLSearchParams {
  const params = new URLSearchParams({ maxResults: '50' })
  if (scope.issueKey) {
    params.set('issueKey', scope.issueKey)
  } else if (scope.projectIdOrKey) {
    // Create has no issue yet; Cloud and Server/DC both scope by project here.
    params.set('project', scope.projectIdOrKey)
  }
  if (query?.trim()) {
    // Server/DC filters assignable users by `username`; `query` is Cloud-only.
    params.set(authType === 'server' ? 'username' : 'query', query.trim())
  }
  return params
}

export async function searchAssignableUsers(
  scope: { issueKey?: string | null; projectIdOrKey?: string | null },
  query?: string,
  siteId?: string | null
): Promise<JiraUserSearchResult> {
  const issueKey = scope.issueKey?.trim() || undefined
  const projectIdOrKey = scope.projectIdOrKey?.trim() || undefined
  if (!issueKey && !projectIdOrKey) {
    return { ok: false, error: 'A Jira project or issue is required to search users.' }
  }
  const entry = getClients(siteId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Jira.' }
  }
  const params = buildAssignableSearchParams(
    entry.site.authType,
    { issueKey, projectIdOrKey },
    query
  )
  await acquire()
  try {
    const response = await jiraRequest<JiraRecord[]>(
      entry,
      `${apiBasePath(entry.site)}/user/assignable/search?${params.toString()}`
    )
    return {
      ok: true,
      users: response.map(mapUser).filter((user): user is JiraUser => !!user)
    }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] searchAssignableUsers failed:', error)
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to search Jira users.'
    }
  } finally {
    release()
  }
}

// Kept array-shaped: `jira.listAssignableUsers` is an established RPC whose
// existing readers call .map on the result, so a paired older client must keep
// receiving an array. New callers should use searchAssignableUsers.
export async function listAssignableUsers(
  key: string,
  query?: string,
  siteId?: string | null
): Promise<JiraUser[]> {
  const result = await searchAssignableUsers({ issueKey: key }, query, siteId)
  return result.ok ? result.users : []
}
