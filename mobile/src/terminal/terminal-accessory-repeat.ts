export const TERMINAL_ACCESSORY_REPEAT_DELAY_MS = 400
export const TERMINAL_ACCESSORY_REPEAT_INTERVAL_MS = 45

type TerminalAccessoryRepeatSender<TInput> = (input: TInput) => Promise<boolean>

export function createTerminalAccessoryRepeatSender<TInput>(
  targetHandle: string | null,
  getActiveHandle: () => string | null,
  sendToTerminal: (input: TInput, targetHandle: string) => Promise<boolean>
): TerminalAccessoryRepeatSender<TInput> {
  return (input) => {
    if (!targetHandle || getActiveHandle() !== targetHandle) {
      return Promise.resolve(false)
    }
    return sendToTerminal(input, targetHandle)
  }
}

export function createTerminalAccessoryRepeatController<TInput>() {
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let dispatchTail: Promise<void> | null = null

  const dispatch = (
    input: TInput,
    send: TerminalAccessoryRepeatSender<TInput>,
    activeGeneration: number
  ) => {
    const sendIfCurrent = () =>
      generation === activeGeneration ? send(input) : Promise.resolve(false)
    const result = dispatchTail ? dispatchTail.then(sendIfCurrent) : sendIfCurrent()
    const settled = result.then(
      () => undefined,
      () => undefined
    )
    dispatchTail = settled
    void settled.then(() => {
      if (dispatchTail === settled) {
        dispatchTail = null
      }
    })
    return result
  }

  const stop = () => {
    generation += 1
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const start = (input: TInput, send: TerminalAccessoryRepeatSender<TInput>) => {
    stop()
    const activeGeneration = generation
    const pressedAt = Date.now()

    const schedule = (delayMs: number) => {
      timer = setTimeout(() => {
        timer = null
        if (generation !== activeGeneration) {
          return
        }
        void dispatch(input, send, activeGeneration).then(
          (sent) => {
            if (sent && generation === activeGeneration) {
              schedule(TERMINAL_ACCESSORY_REPEAT_INTERVAL_MS)
            }
          },
          () => undefined
        )
      }, delayMs)
    }

    void dispatch(input, send, activeGeneration).then(
      (sent) => {
        if (sent && generation === activeGeneration) {
          schedule(
            Math.min(
              TERMINAL_ACCESSORY_REPEAT_DELAY_MS,
              Math.max(0, TERMINAL_ACCESSORY_REPEAT_DELAY_MS - (Date.now() - pressedAt))
            )
          )
        }
      },
      () => undefined
    )
  }

  return { start, stop }
}
