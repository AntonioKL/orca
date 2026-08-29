// STA-2709: creating a Jira issue failed with "Reporter is required." because the
// renderer sent the reporter as text and createIssue forwarded it verbatim. This
// pins the whole seam — picked account id in, `{"reporter":{"id":...}}` out.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraClientForSite } from './authenticated-request'
import { buildJiraUserFieldValue } from '../../shared/jira-user-field-value'

const { getClientsMock, isAuthErrorMock, jiraRequestMock } = vi.hoisted(() => ({
  getClientsMock: vi.fn(),
  isAuthErrorMock: vi.fn(),
  jiraRequestMock: vi.fn()
}))

vi.mock('./request-queue', () => ({ acquire: vi.fn(), release: vi.fn() }))

vi.mock('./authenticated-request', () => ({
  apiBasePath: (site: { authType?: string }) =>
    site.authType === 'server' ? '/rest/api/2' : '/rest/api/3',
  jiraRequest: (...args: unknown[]) => jiraRequestMock(...args)
}))

vi.mock('./client', () => ({
  clearToken: vi.fn(),
  getClients: (...args: unknown[]) => getClientsMock(...args),
  isAuthError: (...args: unknown[]) => isAuthErrorMock(...args)
}))

function entry(authType?: 'cloud' | 'server'): JiraClientForSite {
  return {
    site: {
      id: 'site-1',
      siteUrl: 'https://example.atlassian.net',
      email: 'ada@example.com',
      displayName: 'Example Jira',
      accountId: 'account-1',
      ...(authType ? { authType } : {})
    },
    authorization: 'Basic token'
  }
}

function postedFields(): Record<string, unknown> {
  const init = jiraRequestMock.mock.calls[0]?.[2] as { body?: string } | undefined
  return (
    (JSON.parse(String(init?.body ?? '{}')) as { fields?: Record<string, unknown> }).fields ?? {}
  )
}

async function createWithReporter(
  draft: string,
  authType?: 'cloud' | 'server'
): Promise<Record<string, unknown>> {
  getClientsMock.mockReturnValue([entry(authType)])
  jiraRequestMock.mockResolvedValue({ id: '1', key: 'ENG-1', self: 'https://example' })
  const { createIssue } = await import('./jira-issue-mutations')
  const result = await createIssue({
    projectId: '100',
    issueTypeId: '10001',
    title: 'Broken login',
    // Exactly the marker the create dialog builds from a picked user; the
    // renderer half of that seam is pinned in task-page-jira-create-fields.test.
    customFields: { reporter: buildJiraUserFieldValue(draft) },
    // The dialog derives this from Jira's create metadata, which declares
    // reporter as schema.type 'user'.
    userFieldKeys: ['reporter']
  })
  expect(result.ok).toBe(true)
  return postedFields()
}

describe('Jira create reporter payload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    jiraRequestMock.mockReset()
  })

  it('sends a picked Cloud account id as {"reporter":{"id":...}}', async () => {
    const fields = await createWithReporter('5b10a2844c20165700ede21g')

    expect(fields.reporter).toEqual({ id: '5b10a2844c20165700ede21g' })
    expect(typeof fields.reporter).not.toBe('string')
  })

  it('sends a Server/DC username as {"reporter":{"name":...}}, which has no accountId', async () => {
    const fields = await createWithReporter('ada', 'server')

    expect(fields.reporter).toEqual({ name: 'ada' })
  })

  it('omits the reporter entirely when nothing was picked', async () => {
    const fields = await createWithReporter('   ')

    expect('reporter' in fields).toBe(false)
  })

  it('leaves option-shaped custom fields alone', async () => {
    getClientsMock.mockReturnValue([entry()])
    jiraRequestMock.mockResolvedValue({ id: '1', key: 'ENG-1', self: 'https://example' })
    const { createIssue } = await import('./jira-issue-mutations')

    await createIssue({
      projectId: '100',
      issueTypeId: '10001',
      title: 'Broken login',
      customFields: { customfield_1: { id: 'opt-1' }, customfield_2: 'free text' }
    })

    const fields = postedFields()
    expect(fields.customfield_1).toEqual({ id: 'opt-1' })
    expect(fields.customfield_2).toBe('free text')
  })
})

// Thread 1: the {accountId} marker is structural, so without Jira's own verdict on
// which keys are user fields any lookalike object would be rewritten on its way out.
describe('Jira create user-field scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthErrorMock.mockReturnValue(false)
    jiraRequestMock.mockReset()
  })

  async function createWithFields(
    customFields: Record<string, unknown>,
    userFieldKeys?: string[],
    authType?: 'cloud' | 'server'
  ): Promise<Record<string, unknown>> {
    getClientsMock.mockReturnValue([entry(authType)])
    jiraRequestMock.mockResolvedValue({ id: '1', key: 'ENG-1', self: 'https://example' })
    const { createIssue } = await import('./jira-issue-mutations')
    const result = await createIssue({
      projectId: '100',
      issueTypeId: '10001',
      title: 'Broken login',
      customFields,
      userFieldKeys
    })
    expect(result.ok).toBe(true)
    return postedFields()
  }

  it('leaves an accountId-shaped value alone on a field Jira did not declare as a user field', async () => {
    const fields = await createWithFields(
      { reporter: { accountId: '5abc' }, customfield_1: { accountId: 'not-a-user' } },
      ['reporter']
    )

    expect(fields.reporter).toEqual({ id: '5abc' })
    expect(fields.customfield_1).toEqual({ accountId: 'not-a-user' })
  })

  it('leaves an accountId-shaped value alone when no field types were declared at all', async () => {
    const fields = await createWithFields({ customfield_1: { accountId: 'not-a-user' } })

    expect(fields.customfield_1).toEqual({ accountId: 'not-a-user' })
  })

  it('keeps resolving every entry of a declared array-of-users field', async () => {
    const fields = await createWithFields(
      { customfield_2: [{ accountId: '5abc' }, { accountId: '5def' }] },
      ['customfield_2']
    )

    expect(fields.customfield_2).toEqual([{ id: '5abc' }, { id: '5def' }])
  })

  it('keeps resolving a declared array-of-users field for Server/DC', async () => {
    const fields = await createWithFields(
      { customfield_2: [{ accountId: 'ada' }, { accountId: 'grace' }] },
      ['customfield_2'],
      'server'
    )

    expect(fields.customfield_2).toEqual([{ name: 'ada' }, { name: 'grace' }])
  })
})
