import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'

const {
  clearTokenMock,
  getClientsMock,
  isAuthErrorMock,
  jiraRequestMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  clearTokenMock: vi.fn(),
  getClientsMock: vi.fn(),
  isAuthErrorMock: vi.fn(),
  jiraRequestMock: vi.fn(),
  acquireMock: vi.fn().mockResolvedValue(undefined),
  releaseMock: vi.fn()
}))

vi.mock('./request-queue', () => ({ acquire: acquireMock, release: releaseMock }))

vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args)
}))

vi.mock('./client', () => ({
  clearToken: (...args: unknown[]) => clearTokenMock(...args),
  getClients: (...args: unknown[]) => getClientsMock(...args),
  isAuthError: (...args: unknown[]) => isAuthErrorMock(...args)
}))

function cloudEntry(): JiraClientForSite {
  return {
    site: {
      id: 'site-1',
      siteUrl: 'https://example.atlassian.net',
      email: 'ada@example.com',
      displayName: 'Example Jira',
      accountId: 'account-1'
    },
    authorization: 'Basic token'
  }
}

function serverEntry(): JiraClientForSite {
  return {
    site: {
      id: 'server-1',
      siteUrl: 'https://jira.example.com',
      email: '',
      displayName: 'Self-hosted Jira',
      accountId: 'ada',
      authType: 'server'
    },
    authorization: 'Bearer pat'
  }
}

function requestedPath(): string {
  return String(jiraRequestMock.mock.calls[0]?.[1] ?? '')
}

describe('searchAssignableUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    getClientsMock.mockReturnValue([cloudEntry()])
    acquireMock.mockResolvedValue(undefined)
    jiraRequestMock.mockReset()
  })

  it('scopes a create-time search to the project, since no issue key exists yet', async () => {
    jiraRequestMock.mockResolvedValue([
      { accountId: '5abc', displayName: 'Alex Rivera', emailAddress: 'alex@example.com' }
    ])
    const { searchAssignableUsers } = await import('./jira-user-search')

    const result = await searchAssignableUsers({ projectIdOrKey: 'ENG' }, 'Alex')

    const path = requestedPath()
    expect(path).toContain('/rest/api/3/user/assignable/search?')
    expect(path).toContain('project=ENG')
    expect(path).toContain('query=Alex')
    expect(path).not.toContain('issueKey=')
    expect(result).toEqual({
      ok: true,
      users: [
        {
          accountId: '5abc',
          displayName: 'Alex Rivera',
          email: 'alex@example.com',
          avatarUrl: undefined
        }
      ]
    })
  })

  it('keeps the issue-scoped search for an existing issue', async () => {
    jiraRequestMock.mockResolvedValue([])
    const { searchAssignableUsers } = await import('./jira-user-search')

    await searchAssignableUsers({ issueKey: 'ENG-1' }, 'Alex')

    expect(requestedPath()).toContain('issueKey=ENG-1')
    expect(requestedPath()).not.toContain('project=')
  })

  it('filters Server/DC by username, which has no Cloud query parameter', async () => {
    getClientsMock.mockReturnValue([serverEntry()])
    jiraRequestMock.mockResolvedValue([])
    const { searchAssignableUsers } = await import('./jira-user-search')

    await searchAssignableUsers({ projectIdOrKey: 'ENG' }, 'ada')

    const path = requestedPath()
    expect(path).toContain('/rest/api/2/user/assignable/search?')
    expect(path).toContain('username=ada')
    expect(path).not.toContain('query=ada')
  })

  it('reports a failed search instead of an empty list', async () => {
    jiraRequestMock.mockRejectedValue(new Error('You do not have permission to browse users.'))
    const { searchAssignableUsers } = await import('./jira-user-search')

    const result = await searchAssignableUsers({ projectIdOrKey: 'ENG' }, 'Alex')

    expect(result).toEqual({
      ok: false,
      error: 'You do not have permission to browse users.'
    })
  })

  it('reports a disconnected site rather than looking like a directory with no users', async () => {
    getClientsMock.mockReturnValue([])
    const { searchAssignableUsers } = await import('./jira-user-search')

    expect(await searchAssignableUsers({ projectIdOrKey: 'ENG' })).toEqual({
      ok: false,
      error: 'Not connected to Jira.'
    })
    expect(jiraRequestMock).not.toHaveBeenCalled()
  })

  it('refuses an unscoped search', async () => {
    const { searchAssignableUsers } = await import('./jira-user-search')

    expect(await searchAssignableUsers({ projectIdOrKey: '  ', issueKey: '' }, 'Alex')).toEqual({
      ok: false,
      error: 'A Jira project or issue is required to search users.'
    })
    expect(jiraRequestMock).not.toHaveBeenCalled()
  })

  it('clears the token and rethrows on an auth failure', async () => {
    const authError = new Error('Unauthorized')
    isAuthErrorMock.mockReturnValue(true)
    jiraRequestMock.mockRejectedValue(authError)
    const { searchAssignableUsers } = await import('./jira-user-search')

    await expect(searchAssignableUsers({ projectIdOrKey: 'ENG' })).rejects.toBe(authError)
    expect(clearTokenMock).toHaveBeenCalledWith('site-1')
  })
})

describe('listAssignableUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    getClientsMock.mockReturnValue([cloudEntry()])
    jiraRequestMock.mockReset()
  })

  // The `jira.listAssignableUsers` RPC is array-shaped on the wire and older
  // paired clients call .map on it, so the failure path must stay an empty array.
  it('still returns an array when the search fails', async () => {
    jiraRequestMock.mockRejectedValue(new Error('boom'))
    const { listAssignableUsers } = await import('./jira-user-search')

    await expect(listAssignableUsers('ENG-1', 'Alex')).resolves.toEqual([])
  })

  it('returns the mapped users on success', async () => {
    jiraRequestMock.mockResolvedValue([{ accountId: '5abc', displayName: 'Alex Rivera' }])
    const { listAssignableUsers } = await import('./jira-user-search')

    await expect(listAssignableUsers('ENG-1')).resolves.toEqual([
      { accountId: '5abc', displayName: 'Alex Rivera', email: undefined, avatarUrl: undefined }
    ])
    expect(requestedPath()).toContain('issueKey=ENG-1')
  })
})
