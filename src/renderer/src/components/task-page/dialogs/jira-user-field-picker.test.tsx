// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JiraUserFieldPicker } from './jira-user-field-picker'
import type { JiraUserSearchResult } from '../../../../../shared/jira-types'

afterEach(cleanup)

const ALEX = { accountId: '5b10a2844c20165700ede21g', displayName: 'Alex Rivera' }

function renderPicker(
  searchUsers: (query: string) => Promise<JiraUserSearchResult>,
  value = '',
  onValueChange = vi.fn()
) {
  render(
    <JiraUserFieldPicker
      label="Reporter"
      value={value}
      onValueChange={onValueChange}
      searchUsers={searchUsers}
    />
  )
  return { onValueChange }
}

const SEARCH_PLACEHOLDER = 'Search users or paste an account ID...'

async function open(): Promise<void> {
  fireEvent.click(screen.getByRole('combobox', { name: 'Reporter' }))
  await waitFor(() => expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER)).toBeTruthy())
}

describe('JiraUserFieldPicker', () => {
  it('searches on open and binds the picked account id', async () => {
    const searchUsers = vi.fn(async () => ({ ok: true as const, users: [ALEX] }))
    const { onValueChange } = renderPicker(searchUsers)

    await open()
    await waitFor(() => expect(screen.getByText('Alex Rivera')).toBeTruthy())
    expect(searchUsers).toHaveBeenCalledWith('')

    fireEvent.click(screen.getByText('Alex Rivera'))
    expect(onValueChange).toHaveBeenCalledWith(ALEX.accountId)
  })

  it('says the directory is empty rather than staying blank', async () => {
    renderPicker(vi.fn(async () => ({ ok: true as const, users: [] })))

    await open()
    await waitFor(() => expect(screen.getByText('No matching users.')).toBeTruthy())
  })

  // A swallowed failure that renders as "no results" is what made a broken Jira
  // connection look like an empty directory.
  it('shows why the search failed instead of an empty list', async () => {
    renderPicker(
      vi.fn(async () => ({
        ok: false as const,
        error: 'You do not have permission to browse users.'
      }))
    )

    await open()
    await waitFor(() =>
      expect(
        screen.getByText("Couldn't search Jira users: You do not have permission to browse users.")
      ).toBeTruthy()
    )
    expect(screen.queryByText('No matching users.')).toBeNull()
  })

  it('never parks on a loading state after the search settles', async () => {
    renderPicker(vi.fn(async () => ({ ok: false as const, error: 'Network unreachable' })))

    await open()
    await waitFor(() => expect(screen.getByText(/Network unreachable/)).toBeTruthy())
    expect(screen.queryByText('Searching users...')).toBeNull()
  })

  it('accepts a pasted account id the search never returned', async () => {
    const searchUsers = vi.fn(async () => ({ ok: true as const, users: [] }))
    const { onValueChange } = renderPicker(searchUsers)

    await open()
    fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), {
      target: { value: '5b10a2844c20165700ede21g' }
    })
    const useTyped = await screen.findByText(
      'Use account ID "5b10a2844c20165700ede21g"',
      {},
      { timeout: 3000 }
    )

    fireEvent.click(useTyped)
    expect(onValueChange).toHaveBeenCalledWith('5b10a2844c20165700ede21g')
  })

  it('does not offer the raw option when the search already returned that account', async () => {
    renderPicker(vi.fn(async () => ({ ok: true as const, users: [ALEX] })))

    await open()
    fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), {
      target: { value: ALEX.accountId }
    })
    await waitFor(() => expect(screen.getByText('Alex Rivera')).toBeTruthy())
    expect(screen.queryByText(`Use account ID "${ALEX.accountId}"`)).toBeNull()
  })

  it('labels the trigger with the picked person, not the raw id', async () => {
    const onValueChange = vi.fn()
    renderPicker(
      vi.fn(async () => ({ ok: true as const, users: [ALEX] })),
      '',
      onValueChange
    )

    await open()
    await waitFor(() => expect(screen.getByText('Alex Rivera')).toBeTruthy())
    fireEvent.click(screen.getByText('Alex Rivera'))

    cleanup()
    render(
      <JiraUserFieldPicker
        label="Reporter"
        value={ALEX.accountId}
        onValueChange={vi.fn()}
        searchUsers={vi.fn(async () => ({ ok: true as const, users: [ALEX] }))}
      />
    )
    // Closed and never searched: the raw id is all it can honestly show.
    expect(screen.getByRole('combobox', { name: 'Reporter' }).textContent).toContain(ALEX.accountId)
  })
})
