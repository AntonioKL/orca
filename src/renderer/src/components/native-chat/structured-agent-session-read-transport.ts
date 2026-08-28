import type { AgentJournalCursor } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../../shared/agent-session-wire'
import { createStructuredAgentSessionEventCoalescer } from '../../../../shared/structured-agent-session-coalescer'
import { shouldAdvanceStructuredResumeCursor } from '../../../../shared/structured-agent-session-reducer'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { subscribeStructuredAgentSession } from '@/runtime/structured-agent-session-client'

function createReconnectScheduler(args: { shouldStop: () => boolean; reconnect: () => void }) {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    schedule(delay = 750): void {
      if (args.shouldStop() || timer) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        if (!args.shouldStop()) {
          args.reconnect()
        }
      }, delay)
    },
    dispose(): void {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}

export function startStructuredAgentSessionReadTransport(args: {
  applyEvent: (event: AgentSessionSubscribeEvent) => void
  applyError: (message: string) => void
  getCursor: () => AgentJournalCursor | null
  refreshTail: (isStopped: () => boolean) => Promise<void>
  sessionId: string
  target: RuntimeClientTarget
}): { dispose: () => void; refresh: () => void } {
  let stopped = false
  let connected = false
  let opening = false
  let generation = 0
  let unsubscribe = (): void => {}
  let resumeCursor = args.getCursor()
  const coalescer = createStructuredAgentSessionEventCoalescer(args.applyEvent)
  const reconnectScheduler = createReconnectScheduler({
    shouldStop: () => stopped || connected,
    reconnect: () => void open()
  })
  const isCurrentGeneration = (candidate: number): boolean => !stopped && candidate === generation
  const handleEvent = (event: AgentSessionSubscribeEvent, eventGeneration: number): void => {
    if (!isCurrentGeneration(eventGeneration)) {
      return
    }
    if (event.type === 'snapshot' || event.type === 'reset') {
      resumeCursor = event.page.liveCursor ?? event.page.window.nextCursor
    } else if (
      event.type === 'batch' &&
      shouldAdvanceStructuredResumeCursor(resumeCursor, event.batch.cursor)
    ) {
      resumeCursor = event.batch.cursor
    } else if (event.type === 'end') {
      connected = false
      reconnectScheduler.schedule()
    }
    coalescer.push(event)
  }
  async function open(): Promise<void> {
    if (stopped || connected) {
      return
    }
    if (opening) {
      reconnectScheduler.schedule()
      return
    }
    opening = true
    coalescer.flush()
    const openGeneration = ++generation
    unsubscribe()
    unsubscribe = (): void => {}
    try {
      let closedDuringOpen = false
      const handle = await subscribeStructuredAgentSession(
        args.target,
        { sessionId: args.sessionId, ...(resumeCursor ? { cursor: resumeCursor } : {}) },
        (event) => handleEvent(event, openGeneration),
        (error) => {
          if (!isCurrentGeneration(openGeneration)) {
            return
          }
          closedDuringOpen = true
          connected = false
          args.applyError(String(error))
          reconnectScheduler.schedule()
        },
        () => {
          if (!isCurrentGeneration(openGeneration)) {
            return
          }
          closedDuringOpen = true
          connected = false
          reconnectScheduler.schedule()
        }
      )
      if (!isCurrentGeneration(openGeneration) || closedDuringOpen) {
        handle.unsubscribe()
        if (isCurrentGeneration(openGeneration)) {
          reconnectScheduler.schedule()
        }
      } else {
        connected = true
        unsubscribe = handle.unsubscribe
      }
    } catch (error) {
      if (!isCurrentGeneration(openGeneration)) {
        return
      }
      connected = false
      args.applyError(String(error))
      reconnectScheduler.schedule()
    } finally {
      if (openGeneration === generation) {
        opening = false
      }
    }
  }
  const refresh = (): void => {
    const refreshGeneration = generation
    void args
      .refreshTail(() => stopped)
      .then(() => {
        if (!isCurrentGeneration(refreshGeneration)) {
          return
        }
        resumeCursor = args.getCursor()
        if (!connected) {
          reconnectScheduler.schedule(0)
        }
      })
      .catch((error) => {
        if (isCurrentGeneration(refreshGeneration)) {
          args.applyError(String(error))
        }
      })
  }
  const initialGeneration = generation
  void args
    .refreshTail(() => stopped)
    .then(() => {
      if (!isCurrentGeneration(initialGeneration)) {
        return
      }
      resumeCursor = args.getCursor()
      return open()
    })
    .catch((error) => {
      if (isCurrentGeneration(initialGeneration)) {
        args.applyError(String(error))
        reconnectScheduler.schedule()
      }
    })
  return {
    dispose: () => {
      stopped = true
      generation += 1
      reconnectScheduler.dispose()
      coalescer.dispose()
      unsubscribe()
    },
    refresh
  }
}
