import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { JiraUser, JiraUserSearchResult } from '../../../../../shared/jira-types'

const SEARCH_DEBOUNCE_MS = 250

type SearchState =
  | { status: 'loading' }
  | { status: 'ready'; users: JiraUser[] }
  | { status: 'error'; error: string }

export function JiraUserFieldPicker({
  label,
  value,
  onValueChange,
  searchUsers,
  disabled,
  multiple = false
}: {
  label: string
  value: string
  onValueChange: (value: string) => void
  // Must be referentially stable: it re-triggers the search when it changes.
  searchUsers: (query: string) => Promise<JiraUserSearchResult>
  disabled?: boolean
  multiple?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<SearchState>({ status: 'ready', users: [] })
  const [pickedNames, setPickedNames] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setSearch({ status: 'loading' })
    const timer = setTimeout(
      () => {
        void searchUsers(query).then((result) => {
          if (cancelled) {
            return
          }
          setSearch(
            result.ok
              ? { status: 'ready', users: result.users }
              : { status: 'error', error: result.error }
          )
        })
      },
      query.trim() ? SEARCH_DEBOUNCE_MS : 0
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query, searchUsers])

  const users = useMemo(() => (search.status === 'ready' ? search.users : []), [search])
  const selectedAccountIds = useMemo(
    () =>
      multiple
        ? value
            .split(',')
            .map((accountId) => accountId.trim())
            .filter(Boolean)
        : value.trim()
          ? [value.trim()]
          : [],
    [multiple, value]
  )
  const trimmedQuery = query.trim()
  // Jira accepts an accountId the search never surfaced (restricted directory,
  // a value pasted from Jira itself), so a typed identifier stays selectable.
  const showRawValueOption =
    trimmedQuery.length > 0 &&
    search.status !== 'loading' &&
    !users.some((user) => user.accountId === trimmedQuery)

  const selectedLabel = useMemo(() => {
    if (selectedAccountIds.length === 0) {
      return ''
    }
    return selectedAccountIds
      .map(
        (accountId) =>
          users.find((user) => user.accountId === accountId)?.displayName ??
          pickedNames[accountId] ??
          accountId
      )
      .join(', ')
  }, [pickedNames, selectedAccountIds, users])

  const handleSelect = useCallback(
    (accountId: string, displayName?: string) => {
      const nextAccountIds = multiple
        ? selectedAccountIds.includes(accountId)
          ? selectedAccountIds.filter((selected) => selected !== accountId)
          : [...selectedAccountIds, accountId]
        : [accountId]
      onValueChange(nextAccountIds.join(', '))
      if (displayName) {
        setPickedNames((prev) => ({ ...prev, [accountId]: displayName }))
      }
      if (!multiple) {
        setOpen(false)
        setQuery('')
      }
    },
    [multiple, onValueChange, selectedAccountIds]
  )

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
          className="h-9 w-full justify-between px-3 text-left text-xs font-normal"
        >
          {selectedLabel ? (
            <span className="min-w-0 truncate">{selectedLabel}</span>
          ) : (
            <span className="min-w-0 truncate text-muted-foreground">
              {translate(
                'auto.components.task.page.dialogs.jira.user.field.picker.selectUser',
                'Select {{value0}}',
                { value0: label }
              )}
            </span>
          )}
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={translate(
              'auto.components.task.page.dialogs.jira.user.field.picker.searchPlaceholder',
              'Search users or paste an account ID...'
            )}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-56">
            {search.status === 'loading' ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {translate(
                  'auto.components.task.page.dialogs.jira.user.field.picker.searching',
                  'Searching users...'
                )}
              </div>
            ) : null}
            {search.status === 'error' ? (
              <div className="px-3 py-4 text-center text-xs text-destructive">
                {translate(
                  'auto.components.task.page.dialogs.jira.user.field.picker.searchFailed',
                  "Couldn't search Jira users: {{value0}}",
                  { value0: search.error }
                )}
              </div>
            ) : null}
            {search.status === 'ready' ? (
              <CommandEmpty>
                {translate(
                  'auto.components.task.page.dialogs.jira.user.field.picker.noUsers',
                  'No matching users.'
                )}
              </CommandEmpty>
            ) : null}
            {users.map((user) => (
              <CommandItem
                key={user.accountId}
                value={user.accountId}
                onSelect={() => handleSelect(user.accountId, user.displayName)}
                className="items-center gap-2 px-3 py-2 text-xs"
              >
                <Check
                  className={cn(
                    'size-3.5 text-foreground',
                    selectedAccountIds.includes(user.accountId) ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{user.displayName}</span>
                {user.email ? (
                  <span className="min-w-0 shrink truncate text-muted-foreground">
                    {user.email}
                  </span>
                ) : null}
              </CommandItem>
            ))}
            {showRawValueOption ? (
              <CommandItem
                value={`raw:${trimmedQuery}`}
                onSelect={() => handleSelect(trimmedQuery)}
                className="items-center gap-2 px-3 py-2 text-xs"
              >
                <Check
                  className={cn(
                    'size-3.5 text-foreground',
                    selectedAccountIds.includes(trimmedQuery) ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <span className="min-w-0 flex-1 truncate">
                  {translate(
                    'auto.components.task.page.dialogs.jira.user.field.picker.useTypedId',
                    'Use account ID "{{value0}}"',
                    { value0: trimmedQuery }
                  )}
                </span>
              </CommandItem>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
