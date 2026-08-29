import type { JiraCreateField, JiraIssueType, JiraPriority } from '../../shared/jira-types'
import { acquire, release } from './request-queue'
import { apiBasePath, jiraRequest } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import {
  getCreateFieldRecords,
  mapCreateField,
  mapIssueType,
  mapPriority
} from './jira-issue-mapping'
import {
  asFiniteNumber,
  fetchPagedRecords,
  shouldFetchNextPage,
  type JiraPagedResponse,
  type JiraRecord
} from './jira-record-pages'

export async function listIssueTypes(
  projectIdOrKey: string,
  siteId?: string | null
): Promise<JiraIssueType[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const issueTypes = await fetchPagedRecords(entry, 'issueTypes', (startAt, maxResults) => {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        startAt: String(startAt)
      })
      // Per-project createmeta paths exist on Server/DC from Jira 8.4 onward.
      return `${apiBasePath(entry.site)}/issue/createmeta/${encodeURIComponent(
        projectIdOrKey
      )}/issuetypes?${params.toString()}`
    })
    return issueTypes.map(mapIssueType)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] listIssueTypes failed:', error)
    return []
  } finally {
    release()
  }
}

export async function listCreateFields(
  projectIdOrKey: string,
  issueTypeId: string,
  siteId?: string | null
): Promise<JiraCreateField[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const fields: JiraCreateField[] = []
    let startAt = 0
    const maxResults = 100
    for (let guard = 0; guard < 100; guard += 1) {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        startAt: String(startAt)
      })
      const response = await jiraRequest<JiraPagedResponse<JiraRecord>>(
        entry,
        `${apiBasePath(entry.site)}/issue/createmeta/${encodeURIComponent(
          projectIdOrKey
        )}/issuetypes/${encodeURIComponent(issueTypeId)}?${params.toString()}`
      )
      const records = getCreateFieldRecords(response)
      fields.push(
        ...records
          .map((record) => mapCreateField(record))
          .filter((field): field is JiraCreateField => field !== null)
      )
      if (!shouldFetchNextPage(response, startAt, records, maxResults)) {
        break
      }
      startAt += asFiniteNumber(response.maxResults) ?? maxResults
    }
    return fields
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] listCreateFields failed:', error)
    return []
  } finally {
    release()
  }
}

export async function listPriorities(siteId?: string | null): Promise<JiraPriority[]> {
  const entry = getClients(siteId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const response = await jiraRequest<JiraRecord[]>(entry, `${apiBasePath(entry.site)}/priority`)
    return response.map(mapPriority).filter((priority): priority is JiraPriority => !!priority)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[jira] listPriorities failed:', error)
    return []
  } finally {
    release()
  }
}
