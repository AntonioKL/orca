import React from 'react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
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

/** Unsearchable host picker for eight or fewer entries (design doc, UX section). */

export type AutomationHostPickerSelectProps = {
  entries: readonly AutomationHostCatalogEntry[]
  selectedStableKey: string | null
  /** What the trigger must say when no item matches the selection. */
  triggerLabel: string
  pickerLabel: string
  disabled?: boolean
  onSelect: (filter: AutomationHostFilter) => void
  className?: string
}

export function AutomationHostPickerSelect({
  entries,
  selectedStableKey,
  triggerLabel,
  pickerLabel,
  disabled,
  onSelect,
  className
}: AutomationHostPickerSelectProps): React.JSX.Element {
  const groups = groupAutomationHostEntriesByAuthority(entries)
  const byStableKey = new Map(entries.map((entry) => [entry.stableKey, entry]))

  const handleChange = (value: string): void => {
    if (value === ALL_HOSTS_OPTION_VALUE) {
      onSelect({ kind: 'all' })
      return
    }
    const entry = byStableKey.get(value)
    if (entry) {
      onSelect(automationHostFilterForEntry(entry))
    }
  }

  return (
    <Select
      value={selectedStableKey ?? ALL_HOSTS_OPTION_VALUE}
      onValueChange={handleChange}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={pickerLabel}
        data-picker-variant="select"
        className={cn('h-8 text-xs', className)}
      >
        {/* Without children Radix names the trigger from the matching item, and a
            retained-but-unhydrated selection matches only the All hosts item. */}
        <SelectValue>{selectedStableKey === null ? triggerLabel : undefined}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_HOSTS_OPTION_VALUE} className="text-xs">
          {translate('auto.components.automations.hostPicker.allHosts', 'All hosts')}
        </SelectItem>
        {/* Real Group/Label: the authority names the group itself, so rows need no repeated authority text. */}
        {groups.map((group) => (
          <SelectGroup key={group.authorityKey} data-authority-key={group.authorityKey}>
            <SelectLabel>{group.authorityLabel}</SelectLabel>
            {group.entries.map((entry) => (
              <SelectItem
                key={entry.stableKey}
                value={entry.stableKey}
                className="text-xs"
                data-host-stable-key={entry.stableKey}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <AutomationHostLabel entry={entry} className="min-w-0" />
                  <AutomationHostStatusBadges entry={entry} />
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
