import React from 'react'
import { translate } from '@/i18n/i18n'
import type { AutomationHostFilter } from '../../../../shared/automation-host-filter'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import type { AutomationHostFilterResolution } from './automation-host-filter-resolution'
import { AutomationHostPickerCommand } from './AutomationHostPickerCommand'
import { AutomationHostPickerSelect } from './AutomationHostPickerSelect'

/**
 * The `Filter by host` control. Presentational: it takes the catalog and the
 * resolved filter and reports selections back — it never reads a store or fetches.
 */

/** Design doc: Select at eight or fewer host entries, searchable Command/Popover at nine or more. */
export const AUTOMATION_HOST_PICKER_SELECT_MAX_ENTRIES = 8

export type AutomationHostPickerProps = {
  entries: readonly AutomationHostCatalogEntry[]
  resolution: AutomationHostFilterResolution
  onSelect: (filter: AutomationHostFilter) => void
  /** Overrides the Select/Command switch point; production callers leave this alone. */
  selectMaxEntries?: number
  disabled?: boolean
  className?: string
}

function triggerLabelFor(resolution: AutomationHostFilterResolution): string {
  if (resolution.effective.kind === 'all') {
    return translate('auto.components.automations.hostPicker.allHosts', 'All hosts')
  }
  return (
    resolution.entry?.label ??
    // A retained-but-unhydrated selection must not render as All hosts.
    translate('auto.components.automations.hostPicker.loadingHost', 'Loading host…')
  )
}

export function AutomationHostPicker({
  entries,
  resolution,
  onSelect,
  selectMaxEntries = AUTOMATION_HOST_PICKER_SELECT_MAX_ENTRIES,
  disabled,
  className
}: AutomationHostPickerProps): React.JSX.Element {
  const pickerLabel = translate('auto.components.automations.hostPicker.label', 'Filter by host')
  const selectedStableKey =
    resolution.effective.kind === 'all' ? null : (resolution.entry?.stableKey ?? null)

  if (entries.length <= selectMaxEntries) {
    return (
      <AutomationHostPickerSelect
        entries={entries}
        selectedStableKey={selectedStableKey}
        triggerLabel={triggerLabelFor(resolution)}
        pickerLabel={pickerLabel}
        disabled={disabled}
        onSelect={onSelect}
        className={className}
      />
    )
  }
  return (
    <AutomationHostPickerCommand
      entries={entries}
      selectedStableKey={selectedStableKey}
      triggerLabel={triggerLabelFor(resolution)}
      pickerLabel={pickerLabel}
      disabled={disabled}
      onSelect={onSelect}
      className={className}
    />
  )
}
