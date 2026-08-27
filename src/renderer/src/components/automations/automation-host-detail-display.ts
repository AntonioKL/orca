/**
 * The host a stored automation belongs to, named on the detail view.
 *
 * The catalog entry the row was listed from is the truthful source: it names the
 * storing authority too, which the record's own execution target cannot — a
 * runtime-stored automation's target reads `local`, meaning local to that
 * server, not to this Mac. The record's target is only the fallback for a legacy
 * row no host answered for.
 */

import type { Automation } from '../../../../shared/automations-types'
import { getExecutionHostLabel, toSshExecutionHostId } from '../../../../shared/execution-host'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'

export type AutomationHostDetailDisplay = {
  label: string
  /** Authority-qualified when the two differ; a self host is its own authority. */
  title: string
}

export function getAutomationHostDetailDisplay(input: {
  automation: Pick<Automation, 'executionTargetType' | 'executionTargetId'>
  entry?: AutomationHostCatalogEntry | null
  hostLabelById?: ReadonlyMap<string, string>
}): AutomationHostDetailDisplay {
  const { automation, entry, hostLabelById } = input
  if (entry) {
    return {
      label: entry.label,
      title:
        entry.authorityLabel === entry.label
          ? entry.label
          : `${entry.authorityLabel} · ${entry.label}`
    }
  }
  const hostId =
    automation.executionTargetType === 'ssh'
      ? toSshExecutionHostId(automation.executionTargetId)
      : 'local'
  const label = hostLabelById?.get(hostId) ?? getExecutionHostLabel(hostId)
  return { label, title: label }
}
