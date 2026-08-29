// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
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

const PARTICIPANTS: JiraCreateField = {
  key: 'customfield_10',
  name: 'Participants',
  required: true,
  schema: { type: 'array', items: 'user' }
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

  it('keeps every selection for a multi-user field', async () => {
    const alex = { accountId: 'account-1', displayName: 'Alex Rivera' }
    const blair = { accountId: 'account-2', displayName: 'Blair Chen' }
    const searchUsers = vi.fn(async () => ({ ok: true as const, users: [alex, blair] }))

    function Harness(): React.JSX.Element {
      const [values, setValues] = useState<Record<string, string>>({})
      return (
        <>
          <NewJiraIssueCustomFields
            visibleJiraCreateFields={[PARTICIPANTS]}
            newJiraIssueCustomFieldValues={values}
            setNewJiraIssueCustomFieldValues={setValues}
            newJiraIssueSubmitting={false}
            searchJiraCreateUsers={searchUsers}
          />
          <output aria-label="participant ids">{values[PARTICIPANTS.key]}</output>
        </>
      )
    }

    render(<Harness />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Participants' }))
    await waitFor(() => expect(screen.getByText(alex.displayName)).toBeTruthy())
    fireEvent.click(screen.getByText(alex.displayName))
    expect(screen.getByPlaceholderText('Search users or paste an account ID...')).toBeTruthy()
    await waitFor(() => expect(screen.getByText(blair.displayName)).toBeTruthy())
    fireEvent.click(screen.getByText(blair.displayName))

    expect(screen.getByLabelText('participant ids').textContent).toBe('account-1, account-2')
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
