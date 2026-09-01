/**
 * Remembers which provider generations are closed, without growing forever.
 *
 * Provider generations are minted monotonically — one per relay reconnect — and a closed generation
 * is closed for good, so a plain Set of every closed id grew without bound for the life of the
 * process. Contiguous closed runs collapse into a single high-water mark; only out-of-order closes
 * above it are retained, and they drain as the gap fills.
 */
export class ClosedGenerationLedger {
  private closedThrough: number | null = null
  private readonly ahead = new Set<number>()

  has(generation: number): boolean {
    return (
      (this.closedThrough !== null && generation <= this.closedThrough) ||
      this.ahead.has(generation)
    )
  }

  add(generation: number): void {
    if (this.has(generation)) {
      return
    }
    this.ahead.add(generation)
    if (this.closedThrough === null) {
      this.closedThrough = generation
      this.ahead.delete(generation)
    }
    while (this.ahead.delete(this.closedThrough + 1)) {
      this.closedThrough += 1
    }
  }

  /** Retained out-of-order entries; zero whenever generations close in order. */
  get pendingSize(): number {
    return this.ahead.size
  }
}
