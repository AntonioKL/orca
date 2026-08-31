import {
  RELAY_ADMISSION_BUDGETS,
  RELAY_CELL_ADMISSION_BOUNDS,
  RELAY_CELL_CONNECTION_HARD_CAP,
  RELAY_CELL_CONNECTION_HARD_CAPS,
  relayCellAdmissionBounds
} from '@orca-cloud/relay-contract'
import { describe, expect, it } from 'vitest'

describe('cell connection hard cap', () => {
  it('derives its own bounds from the cap', () => {
    expect(RELAY_CELL_ADMISSION_BOUNDS.hardCap).toBe(RELAY_CELL_CONNECTION_HARD_CAP)
    expect(RELAY_CELL_ADMISSION_BOUNDS.socketAdmissionCeiling).toBe(
      RELAY_CELL_CONNECTION_HARD_CAP - RELAY_ADMISSION_BUDGETS.reservedHostControls
    )
    expect(RELAY_CELL_ADMISSION_BOUNDS.maxUnobservedBound).toBe(
      RELAY_CELL_ADMISSION_BOUNDS.socketAdmissionCeiling - 1
    )
    for (const hardCap of RELAY_CELL_CONNECTION_HARD_CAPS) {
      const bounds = relayCellAdmissionBounds(hardCap)
      expect(bounds.socketAdmissionCeiling).toBe(
        hardCap - RELAY_ADMISSION_BUDGETS.reservedHostControls
      )
      expect(bounds.maxUnobservedBound).toBe(bounds.socketAdmissionCeiling - 1)
    }
  })
})
