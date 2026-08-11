import React, { useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { AutomationHostFilter } from '../../../../shared/automation-host-filter'
import { AutomationHostLabel, AutomationHostStatusBadges } from './AutomationHostBadges'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import {
  ALL_HOSTS_OPTION_VALUE,
  automationHostFilterForEntry,
  groupAutomationHostEntriesByAuthority
} from './automation-host-picker-groups'

/**
 * Searchable host picker for nine or more entries (design doc, UX section).
 * Search focuses on open, Enter selects, Esc closes without changing selection.
 */

export type AutomationHostPickerCommandProps = {
  entries: readonly AutomationHostCatalogEntry[]
  selectedStableKey: string | null
  triggerLabel: string
  pickerLabel: string
  disabled?: boolean
  onSelect: (filter: AutomationHostFilter) => void
  className?: string
}

export function AutomationHostPickerCommand({
  entries,
  selectedStableKey,
  triggerLabel,
  pickerLabel,
  disabled,
  onSelect,
  className
}: AutomationHostPickerCommandProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const groups = groupAutomationHostEntriesByAuthority(entries)

  const choose = (filter: AutomationHostFilter): void => {
    onSelect(filter)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={pickerLabel}
          data-picker-variant="command"
          disabled={disabled}
          className={cn('h-8 justify-between gap-2 text-xs font-normal', className)}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[min(22rem,calc(100vw-1rem))] p-0">
        <Command>
          <CommandInput
            autoFocus
            placeholder={translate(
              'auto.components.automations.hostPicker.searchPlaceholder',
              'Search hosts'
            )}
            aria-label={pickerLabel}
            className="h-9 text-xs"
          />
          <CommandList className="scrollbar-sleek max-h-72">
            <CommandEmpty className="py-4 text-xs text-muted-foreground">
              {translate('auto.components.automations.hostPicker.noHostMatch', 'No hosts match')}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={ALL_HOSTS_OPTION_VALUE}
                onSelect={() => choose({ kind: 'all' })}
                className="text-xs"
              >
                <Check
                  className={cn(
                    'size-3 text-muted-foreground',
                    selectedStableKey === null ? 'opacity-70' : 'opacity-0'
                  )}
                />
                {translate('auto.components.automations.hostPicker.allHosts', 'All hosts')}
              </CommandItem>
            </CommandGroup>
            {groups.map((group) => (
              <CommandGroup key={group.authorityKey} heading={group.authorityLabel}>
                {group.entries.map((entry) => (
                  <CommandItem
                    // Why: cmdk filters on `value`, so the searchable text is the value itself.
                    key={entry.stableKey}
                    value={`${entry.label} ${entry.authorityLabel} ${entry.stableKey}`}
                    onSelect={() => choose(automationHostFilterForEntry(entry))}
                    className="gap-2 text-xs"
                    data-host-stable-key={entry.stableKey}
                  >
                    <Check
                      className={cn(
                        'size-3 text-muted-foreground',
                        selectedStableKey === entry.stableKey ? 'opacity-70' : 'opacity-0'
                      )}
                    />
                    <AutomationHostLabel entry={entry} className="min-w-0 flex-1" />
                    <AutomationHostStatusBadges entry={entry} />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
