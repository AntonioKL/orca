/**
 * Copy for why an automation is off — and, when it was not the user, what to do.
 *
 * Only the migration's own stamp produces new wording. A user's pause and a
 * record from before the stamp existed both read exactly as they did before, so
 * nothing changes for the automations whose state was never in question.
 */

import type { Automation } from '../../../../shared/automations-types'
import { isAutomationDisabledByOwnerMigration } from '../../../../shared/automation-enablement-decision'
import { translate } from '@/i18n/i18n'

type AutomationEnablement = Pick<Automation, 'enabled' | 'enabledDecidedBy'>

/**
 * Names the decider, not the reason: this label rides in the row's next-run
 * column and the detail badge, both too narrow for a cause. The cause is the
 * notice. Callers show a next-run time instead when the record is running.
 */
export function automationPausedLabel(automation: AutomationEnablement): string {
  return isAutomationDisabledByOwnerMigration(automation)
    ? translate('auto.components.automations.enablement.pausedByOrca', 'Paused by Orca')
    : translate('auto.components.automations.enablement.paused', 'Paused')
}

export type AutomationEnablementNotice = { reason: string; recovery: string }

/** Null for every state the user already understands, which is all but one. */
export function automationEnablementNotice(
  automation: AutomationEnablement
): AutomationEnablementNotice | null {
  if (!isAutomationDisabledByOwnerMigration(automation)) {
    return null
  }
  return {
    // Why not "its host was removed": the migration also pauses records whose
    // workspace spans hosts, where nothing was removed and no single host owns it.
    reason: translate(
      'auto.components.automations.enablement.hostChangedReason',
      'Orca paused this automation because it could not tell which host it belongs to. You did not pause it.'
    ),
    recovery: translate(
      'auto.components.automations.enablement.hostChangedRecovery',
      'Re-add that host to restore it, resume the automation to run it anyway, or delete it if you no longer need it.'
    )
  }
}
