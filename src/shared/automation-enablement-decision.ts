/**
 * Who last decided an automation's `enabled` flag, as both processes read it.
 *
 * The main-side migration already answers this for itself
 * (`automation-owner-migration.ts`), but the renderer cannot import from main —
 * and without the distinction a record Orca switched off is indistinguishable
 * from one the user switched off, which is the half of the orphan-disable
 * complaint the mechanical fix did not answer.
 */

import type { Automation } from './automations-types'

/** Absent on every pre-stamp record, which must keep reading as a plain pause. */
export function isAutomationDisabledByOwnerMigration(
  automation: Pick<Automation, 'enabled' | 'enabledDecidedBy'>
): boolean {
  return !automation.enabled && automation.enabledDecidedBy === 'owner_migration'
}
