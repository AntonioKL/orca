import type { RuntimeTerminalWait } from '../../shared/runtime-types'

const HEADLESS_COMPLETION_TIMEOUT_MS = 5 * 60 * 1000
const BLOCKED_PROMPT_RECHECK_MS = 1_000

type TerminalWaitRuntime = {
  waitForTerminal: (
    handle: string,
    options: { condition: 'tui-idle'; timeoutMs: number }
  ) => Promise<RuntimeTerminalWait>
}

export async function waitForHeadlessAutomationCompletion(
  runtime: TerminalWaitRuntime,
  terminalHandle: string,
  timeoutMs = HEADLESS_COMPLETION_TIMEOUT_MS
): Promise<RuntimeTerminalWait> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new Error('timeout')
    }
    const result = await runtime.waitForTerminal(terminalHandle, {
      condition: 'tui-idle',
      timeoutMs: remainingMs
    })
    if (!result.blockedReason) {
      return result
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(BLOCKED_PROMPT_RECHECK_MS, remainingMs))
    )
  }
}
