type DeferredStartup = {
  isClaudeLaunch: boolean
  incarnationId: string
  operationId: string
  onAccepted: () => void
}

/** Pending launch effects have the same lifetime as their owning PTY route. */
export class PtyOwnershipRegistry extends Map<string, string | null> {
  private readonly deferredStartups = new Map<string, DeferredStartup>()

  override set(id: string, connectionId: string | null): this {
    if (this.has(id) && this.get(id) !== connectionId) {
      this.deferredStartups.delete(id)
    }
    return super.set(id, connectionId)
  }

  override delete(id: string): boolean {
    this.deferredStartups.delete(id)
    return super.delete(id)
  }

  override clear(): void {
    this.deferredStartups.clear()
    super.clear()
  }

  deferStartup(id: string, startup: DeferredStartup): void {
    if (this.has(id)) {
      this.deferredStartups.set(id, startup)
    }
  }

  clearDeferredStartup(id: string): void {
    this.deferredStartups.delete(id)
  }

  hasDeferredStartup(id: string, incarnationId: string | undefined): boolean {
    return (
      incarnationId !== undefined && this.deferredStartups.get(id)?.incarnationId === incarnationId
    )
  }

  getDeferredStartup(
    id: string,
    incarnationId: string,
    operationId: string
  ): DeferredStartup | undefined {
    const startup = this.deferredStartups.get(id)
    return startup?.incarnationId === incarnationId && startup.operationId === operationId
      ? startup
      : undefined
  }

  settleDeferredStartup(id: string, startup: DeferredStartup, accepted: boolean): void {
    if (this.deferredStartups.get(id) !== startup) {
      return
    }
    this.deferredStartups.delete(id)
    if (accepted) {
      startup.onAccepted()
    }
  }
}
