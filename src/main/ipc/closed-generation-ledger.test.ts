import { describe, expect, it } from 'vitest'
import { ClosedGenerationLedger } from './closed-generation-ledger'

describe('ClosedGenerationLedger', () => {
  it('answers the same as a set of every closed generation', () => {
    const ledger = new ClosedGenerationLedger()
    for (const generation of [1, 2, 3, 7, 5, 4, 6]) {
      ledger.add(generation)
    }
    for (let generation = 1; generation <= 7; generation += 1) {
      expect(ledger.has(generation)).toBe(true)
    }
    expect(ledger.has(8)).toBe(false)
    // Anything below the mark reads as closed. That is deliberate and fail-closed: a generation
    // older than one already closed cannot be live, and the dangerous direction here would be
    // answering "open" for a closed generation and admitting its data.
    expect(ledger.has(0)).toBe(true)
  })

  it('retains nothing once an out-of-order gap fills', () => {
    const ledger = new ClosedGenerationLedger()
    ledger.add(1)
    ledger.add(3)
    expect(ledger.pendingSize).toBe(1)
    ledger.add(2)
    expect(ledger.pendingSize).toBe(0)
    expect(ledger.has(3)).toBe(true)
  })

  it('stays flat across a long run of reconnects', () => {
    // The regression this exists for: a plain Set grew one entry per relay reconnect, forever.
    const ledger = new ClosedGenerationLedger()
    for (let generation = 1; generation <= 100_000; generation += 1) {
      ledger.add(generation)
    }
    expect(ledger.pendingSize).toBe(0)
    expect(ledger.has(100_000)).toBe(true)
  })
})
