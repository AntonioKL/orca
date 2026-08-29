// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewJiraIssueCustomFields } from './new-jira-issue-custom-fields'
import type { JiraCreateField } from '../../../../../shared/jira-types'

afterEach(cleanup)

const REPORTER: JiraCreateField = {
  key: 'reporter',
  name: 'Reporter',
  required: true,
  schema: { type: 'user' }
}

const NOTES: JiraCreateField = {
  key: 'customfield_9',
  name: 'Notes',
  required: true,
  schema: { type: 'string' }
}

function renderFields(
  fields: JiraCreateField[],
  searchUsers = vi.fn(async () => ({ ok: true as const, users: [] }))
) {
  const setValues = vi.fn()
  render(
    <NewJiraIssueCustomFields
      visibleJiraCreateFields={fields}
      newJiraIssueCustomFieldValues={{}}
      setNewJiraIssueCustomFieldValues={setValues}
      newJiraIssueSubmitting={false}
      searchJiraCreateUsers={searchUsers}
    />
  )
  return { setValues, searchUsers }
}

describe('NewJiraIssueCustomFields', () => {
  // Jira returns `reporter` with schema.type "user" and no allowedValues, which
  // used to fall through to a free-text Input that could never resolve a user.
  it('renders a searchable picker for a user field, not a text box', async () => {
    const { searchUsers } = renderFields([REPORTER])

    const trigger = screen.getByRole('combobox', { name: 'Reporter' })
    expect(screen.queryByRole('textbox', { name: 'Reporter' })).toBeNull()

    fireEvent.click(trigger)
    await waitFor(() => expect(searchUsers).toHaveBeenCalledWith(''))
  })

  it('leaves non-user fields as their existing text input', () => {
    renderFields([NOTES])

    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeTruthy()
  })

  it('renders nothing when there are no required fields', () => {
    const { container } = render(
      <NewJiraIssueCustomFields
        visibleJiraCreateFields={[]}
        newJiraIssueCustomFieldValues={{}}
        setNewJiraIssueCustomFieldValues={vi.fn()}
        newJiraIssueSubmitting={false}
        searchJiraCreateUsers={vi.fn(async () => ({ ok: true as const, users: [] }))}
      />
    )

    expect(container.firstChild).toBeNull()
  })
})
