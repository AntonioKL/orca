import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_SUBMIT,
  getAgentPromptSubmitDelayMs
} from '../../shared/agent-prompt-injection'
import { iterateTerminalInputChunks } from '../../shared/terminal-input'
import {
  agentSessionPtyWriteGate,
  type AgentSessionPtyWriteAdmittance
} from './agent-session-pty-write-gate'

export type RuntimeTerminalWriteOptions = {
  signal?: AbortSignal
  beforeWrite?: (ptyId: string) => void | Promise<void>
  reserveWrite?: (ptyId: string) => void
  afterWrite?: (ptyId: string) => void | Promise<void>
  suffixFailureError?: string
}

export class RuntimeTerminalWriter {
  constructor(
    private readonly write: (ptyId: string, data: string) => boolean,
    private readonly getWriteHostPlatform: (ptyId: string) => NodeJS.Platform = () =>
      process.platform
  ) {}

  async writeAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions = {}
  ): Promise<void> {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('terminal_write_aborted')
    }
    const hasText = typeof action.text === 'string' && action.text.length > 0
    const hasSuffix = action.enter || action.interrupt
    const admitted = agentSessionPtyWriteGate.assertAdmitted(ptyId)
    if (hasText) {
      await this.writeChunks(ptyId, action.text!, options, admitted)
    }
    if (hasSuffix) {
      const suffix = (action.enter ? '\r' : '') + (action.interrupt ? '\x03' : '')
      if (hasText) {
        await waitForTerminalWriteDelay(
          getAgentPromptSubmitDelayMs(
            this.getWriteHostPlatform(ptyId),
            Buffer.byteLength(action.text!, 'utf8')
          ),
          options.signal
        )
      }
      try {
        agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
        await options.beforeWrite?.(ptyId)
        agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
        options.reserveWrite?.(ptyId)
      } catch (error) {
        if (options.suffixFailureError) {
          throw new Error(options.suffixFailureError)
        }
        throw error
      }
      if (!this.write(ptyId, suffix)) {
        throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
      }
      await options.afterWrite?.(ptyId)
      return
    }
    if (hasText) {
      return
    }
    agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
    await options.beforeWrite?.(ptyId)
    agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
    options.reserveWrite?.(ptyId)
    if (!this.write(ptyId, payload)) {
      throw new Error('terminal_not_writable')
    }
    await options.afterWrite?.(ptyId)
  }

  async writeChunks(
    ptyId: string,
    text: string,
    options: RuntimeTerminalWriteOptions = {},
    admitted: AgentSessionPtyWriteAdmittance = agentSessionPtyWriteGate.assertAdmitted(ptyId)
  ): Promise<void> {
    const chunks = iterateTerminalInputChunks(text)
    let chunk = chunks.next()
    let firstChunk = true
    while (!chunk.done) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error('terminal_write_aborted')
      }
      if (!firstChunk) {
        agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
      }
      firstChunk = false
      await options.beforeWrite?.(ptyId)
      agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
      options.reserveWrite?.(ptyId)
      if (!this.write(ptyId, chunk.value)) {
        throw new Error('terminal_not_writable')
      }
      await options.afterWrite?.(ptyId)
      chunk = chunks.next()
      if (!chunk.done) {
        await yieldBetweenTerminalInputChunks()
      }
    }
  }

  async writeAgentPrompt(
    ptyId: string,
    pastePayload: string,
    options: RuntimeTerminalWriteOptions = {}
  ): Promise<void> {
    let wrotePasteBytes = false
    let completedPaste = false
    try {
      const chunks = iterateTerminalInputChunks(pastePayload)
      let chunk = chunks.next()
      while (!chunk.done) {
        await options.beforeWrite?.(ptyId)
        if (!this.write(ptyId, chunk.value)) {
          throw new Error('terminal_not_writable')
        }
        wrotePasteBytes = true
        chunk = chunks.next()
        if (!chunk.done) {
          await yieldBetweenTerminalInputChunks()
        }
      }
      completedPaste = true
    } catch (error) {
      if (wrotePasteBytes && !completedPaste) {
        this.write(ptyId, AGENT_PROMPT_BRACKETED_PASTE_END)
      }
      throw error
    }
    await waitForTerminalWriteDelay(
      getAgentPromptSubmitDelayMs(
        this.getWriteHostPlatform(ptyId),
        Buffer.byteLength(pastePayload, 'utf8')
      ),
      options.signal
    )
    try {
      await options.beforeWrite?.(ptyId)
    } catch (error) {
      if (options.suffixFailureError) {
        throw new Error(options.suffixFailureError)
      }
      throw error
    }
    if (!this.write(ptyId, AGENT_PROMPT_SUBMIT)) {
      throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
    }
  }
}

function yieldBetweenTerminalInputChunks(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

async function waitForTerminalWriteDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return
  }
  if (signal.aborted) {
    throw new Error('request_aborted')
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('request_aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
    }
  })
}
