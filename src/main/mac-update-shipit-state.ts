import { unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isShipItProvenExited } from '../shared/shipit-liveness'
import { recordUpdaterLifecycle } from './updater-lifecycle-diagnostics'

// Why injectable: this is destructive, and tests must never resolve it to the developer's cache.
let shipItStatePathOverride: string | null = null

function getShipItStatePath(): string {
  return (
    shipItStatePathOverride ??
    join(homedir(), 'Library', 'Caches', 'com.stablyai.orca.ShipIt', 'ShipItState.plist')
  )
}

export function _setShipItStatePathForTests(path: string | null): void {
  shipItStatePathOverride = path
}

/** May this process delete the installer's state file? */
export function canDeleteShipItState(input: {
  hasPathOverride: boolean
  isUnderTest: boolean
}): boolean {
  return input.hasPathOverride || !input.isUnderTest
}

/** Delete Squirrel's staged state only after its installer is proven gone. */
export function clearWedgedShipItState(bundlePath: string): void {
  if (!isShipItProvenExited(bundlePath)) {
    return
  }
  // A forgotten override must not let a test delete the developer's real Squirrel state.
  if (
    !canDeleteShipItState({
      hasPathOverride: shipItStatePathOverride !== null,
      isUnderTest: Boolean(process.env.VITEST)
    })
  ) {
    return
  }
  try {
    unlinkSync(getShipItStatePath())
    recordUpdaterLifecycle(
      'shipit_state_cleared',
      {},
      {
        level: 'warn',
        message: 'Cleared a stale Squirrel install state left behind by a failed update'
      }
    )
  } catch {
    // Absent is normal; stale state exists only after an aborted install.
  }
}
