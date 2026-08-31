import { TERMINAL_INPUT_MAX_BYTES } from '../../../../shared/terminal-input'

export const PTY_PRECONNECT_INPUT_MAX_ENTRIES = 1024
// One UTF-16 code unit encodes to at most three UTF-8 bytes.
export const PTY_PRECONNECT_INPUT_MAX_CODE_UNITS = Math.floor(TERMINAL_INPUT_MAX_BYTES / 3)

type BufferedInput = {
  data: string
  kind: 'ordinary' | 'immediate' | 'accepted'
  resolve?: (accepted: boolean) => void
}

type PreconnectInputWriter = {
  isCurrent: () => boolean
  sendInput: (data: string) => boolean
  sendInputImmediate: (data: string) => boolean
  sendInputAccepted?: (data: string) => Promise<boolean>
}

export type PtyPreconnectInputBuffer = {
  isBuffering: () => boolean
  enqueue: (data: string, kind: 'ordinary' | 'immediate') => boolean
  enqueueAccepted: (data: string) => Promise<boolean>
  flush: (writer: PreconnectInputWriter) => Promise<void>
  clear: () => void
}

export function createPtyPreconnectInputBuffer(): PtyPreconnectInputBuffer {
  let pending: BufferedInput[] = []
  let pendingCodeUnits = 0
  let buffering = true
  let activeAcceptedInput: BufferedInput | null = null
  let activeFlush: Promise<void> | null = null
  let stopFlush!: () => void
  const flushStopped = new Promise<void>((resolve) => {
    stopFlush = resolve
  })

  const retain = (input: BufferedInput): boolean => {
    const activeEntries = activeAcceptedInput ? 1 : 0
    const activeCodeUnits = activeAcceptedInput?.data.length ?? 0
    if (
      !buffering ||
      pending.length + activeEntries >= PTY_PRECONNECT_INPUT_MAX_ENTRIES ||
      input.data.length > PTY_PRECONNECT_INPUT_MAX_CODE_UNITS - pendingCodeUnits - activeCodeUnits
    ) {
      return false
    }
    pending.push(input)
    pendingCodeUnits += input.data.length
    return true
  }
  const createInput = (
    data: string,
    kind: BufferedInput['kind'],
    resolve?: BufferedInput['resolve']
  ): BufferedInput => ({ data, kind, ...(resolve ? { resolve } : {}) })
  const clear = (): void => {
    const dropped = pending
    pending = []
    pendingCodeUnits = 0
    buffering = false
    const inFlight = activeAcceptedInput
    activeAcceptedInput = null
    inFlight?.resolve?.(false)
    for (const input of dropped) {
      input.resolve?.(false)
    }
    stopFlush()
  }

  const runFlush = async (writer: PreconnectInputWriter): Promise<void> => {
    try {
      while (buffering && pending.length > 0) {
        const input = pending.shift()
        if (!input) {
          continue
        }
        pendingCodeUnits -= input.data.length
        if (input.kind === 'accepted') {
          activeAcceptedInput = input
        }
        if (!buffering || !writer.isCurrent()) {
          input.resolve?.(false)
          clear()
          return
        }
        if (input.kind === 'accepted') {
          let accepted: boolean | null = null
          try {
            accepted = await Promise.race([
              Promise.resolve(
                writer.sendInputAccepted
                  ? writer.sendInputAccepted(input.data)
                  : writer.sendInput(input.data)
              ),
              flushStopped.then(() => null)
            ])
          } catch {
            input.resolve?.(false)
            clear()
            return
          } finally {
            if (activeAcceptedInput === input) {
              activeAcceptedInput = null
            }
          }
          if (!buffering || accepted === null) {
            input.resolve?.(false)
            return
          }
          input.resolve?.(accepted)
          if (!accepted) {
            clear()
            return
          }
          continue
        }
        const accepted =
          input.kind === 'immediate'
            ? writer.sendInputImmediate(input.data)
            : writer.sendInput(input.data)
        if (!accepted) {
          clear()
          return
        }
      }
      buffering = false
      stopFlush()
    } catch (error) {
      clear()
      throw error
    }
  }

  const flush = (writer: PreconnectInputWriter): Promise<void> => {
    if (activeFlush) {
      return activeFlush
    }
    if (!buffering) {
      return Promise.resolve()
    }
    const flushPromise = Promise.resolve().then(() => runFlush(writer))
    activeFlush = flushPromise
    const releaseFlight = (): void => {
      if (activeFlush === flushPromise) {
        activeFlush = null
      }
    }
    void flushPromise.then(releaseFlight, releaseFlight)
    return flushPromise
  }

  return {
    isBuffering: () => buffering,
    enqueue(data, kind) {
      const input = createInput(data, kind)
      return retain(input)
    },
    enqueueAccepted(data) {
      return new Promise<boolean>((resolve) => {
        const input = createInput(data, 'accepted', resolve)
        if (!retain(input)) {
          resolve(false)
        }
      })
    },
    flush,
    clear
  }
}
