import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

// Two cells, so the inventory lock covers more than the rebind's own row.
const cells = [
  {
    id: 'rebind-inventory-postgres-a',
    url: 'https://rebind-inventory-postgres-a.example.com',
    capacityRequests: 1_000,
    connectionHardCap: 600 as const,
    connectionUnobservedBound: 50
  },
  {
    id: 'rebind-inventory-postgres-b',
    url: 'https://rebind-inventory-postgres-b.example.com',
    capacityRequests: 1_000,
    connectionHardCap: 600 as const,
    connectionUnobservedBound: 50
  }
]
const identity = { userId: 'rebind-inventory-postgres-user', relayHostId: 'rebindinvhost001' }

function heartbeat(cell: (typeof cells)[number]) {
  return {
    cellId: cell.id,
    cellUrl: cell.url,
    cellIncarnation: '11111111-1111-4111-8111-111111111111',
    startedAt: 50,
    ready: true,
    observedRequests: 0,
    totalConnections: 0,
    inFlightConnections: 0,
    reservedConnectionUnits: 0,
    enforcedConnectionUnits: 0,
    connectionInclusionWatermark: 1,
    connectionHardCap: 600 as const,
    connectionUnobservedBound: 50
  }
}

// Why: every desktop control rebind used to take the fleet-wide relay_cells
// FOR UPDATE lock, so a rebind on one cell queued behind whatever held any
// other cell's row, until COMMIT (55P03 at the request bound). A rebind only
// touches its own cell row, so it must proceed while another cell's row is
// held elsewhere.
describePostgres('PostgreSQL control rebind under a held cell row', () => {
  const databases: RelayDatabase[] = []

  beforeAll(async () => {
    databases.push(
      await openRelayDatabase({ databaseUrl, dataDir: '' }),
      await openRelayDatabase({ databaseUrl, dataDir: '' })
    )
  })

  async function removeTestRows(database: RelayDatabase): Promise<void> {
    await database.query(
      `DELETE FROM relay_control_connection_reservations WHERE user_id = ?`,
      [identity.userId]
    )
    await database.query(
      `DELETE FROM relay_assignment_activity_leases WHERE user_id = ?`,
      [identity.userId]
    )
    await database.query(`DELETE FROM relay_assignments WHERE user_id = ?`, [identity.userId])
    for (const cell of cells) {
      for (const table of [
        'relay_cell_connection_snapshots',
        'relay_cell_connection_runtime',
        'relay_cell_connection_limits',
        'relay_cell_runtime',
        'relay_cells'
      ]) {
        await database.query(`DELETE FROM ${table} WHERE cell_id = ?`, [cell.id])
      }
    }
  }

  afterAll(async () => {
    if (databases[0]) await removeTestRows(databases[0])
    for (const connection of databases) await connection.close()
  })

  it("rebinds and supersedes a control while another cell's row is held", async () => {
    // A prior aborted run leaves connection snapshots that reject a replayed watermark.
    await removeTestRows(databases[0]!)
    const store = new RelayAssignmentStore(databases[0]!, () => 100)
    await store.reconcileCells(cells)
    for (const cell of cells) await store.recordCellHeartbeat(heartbeat(cell))
    // Pin the host to cell A so placement is deterministic.
    await store.setCellEnabled(cells[1]!.id, false)
    const assignment = await store.assign(identity)
    expect(assignment.cellId).toBe(cells[0]!.id)
    await store.setCellEnabled(cells[1]!.id, true)
    await store.activateControl(identity, {
      cellId: cells[0]!.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1,
      connectionInclusionWatermark: 10
    })

    // Hold only cell B's row on a second connection, the way a rebind on B
    // does, for longer than the request-path lock bound.
    let releaseInventory!: () => void
    const inventoryReleased = new Promise<void>((resolve) => {
      releaseInventory = resolve
    })
    let inventoryHeld!: () => void
    const inventoryHeldPromise = new Promise<void>((resolve) => {
      inventoryHeld = resolve
    })
    const holder = databases[1]!.transaction(async (transaction) => {
      await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [cells[1]!.id])
      inventoryHeld()
      await inventoryReleased
    })
    await inventoryHeldPromise

    // A generation-2 rebind on cell A supersedes generation 1. It must not
    // wait on cell B's row.
    const startedAt = Date.now()
    const blockedStatement = async (): Promise<string> => {
      const rows = await databases[1]!.query(
        `SELECT left(query, 160) AS q FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`
      )
      return rows.map((row) => String(row.q)).join(' | ')
    }
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          void blockedStatement().then((statement) =>
            reject(new Error(`rebind on cell A blocked behind cell B's row: ${statement}`))
          ),
        2_000
      )
    )
    const rebound = await Promise.race([
      store.activateControl(identity, {
        cellId: cells[0]!.id,
        assignmentEpoch: assignment.assignmentEpoch,
        generation: 2,
        connectionInclusionWatermark: 11
      }),
      timeout
    ])
    const elapsedMs = Date.now() - startedAt
    releaseInventory()
    await holder

    expect(rebound).toBe(`control:${cells[0]!.id}:2`)
    expect(elapsedMs).toBeLessThan(2_000)
    const controls = await databases[0]!.query(
      `SELECT activity_id FROM relay_assignment_activity_leases
       WHERE user_id = ? AND activity_kind = 'control' ORDER BY activity_id`,
      [identity.userId]
    )
    expect(controls).toEqual([{ activity_id: `control:${cells[0]!.id}:2` }])
    const reserved = await databases[0]!.query(
      `SELECT reserved_requests FROM relay_cells WHERE cell_id = ?`,
      [cells[0]!.id]
    )
    expect(Number(reserved[0]!.reserved_requests)).toBe(1)
  }, 15_000)
})
