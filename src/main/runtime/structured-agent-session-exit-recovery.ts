export type StructuredAgentSessionExitEvent = {
  type: string
  sessionId: string
  cause?: string
}

export function createStructuredAgentSessionExitRecovery(
  handle: (event: StructuredAgentSessionExitEvent) => Promise<unknown> | undefined,
  reportError: (sessionId: string, error: unknown) => void
): {
  queue: (event: StructuredAgentSessionExitEvent) => void
  wait: () => Promise<void>
} {
  let chain: Promise<void> = Promise.resolve()
  const queue = (event: StructuredAgentSessionExitEvent): void => {
    if (event.type !== 'ended' || event.cause !== 'unexpected-exit') {
      return
    }
    chain = chain
      .then(async () => {
        await handle(event)
      })
      .catch((error) => reportError(event.sessionId, error))
  }
  return {
    queue,
    wait: async () => {
      for (;;) {
        const observed = chain
        await observed
        if (observed === chain) {
          return
        }
      }
    }
  }
}
