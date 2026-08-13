import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_SUBMIT,
  AGENT_PROMPT_SUBMIT_DELAY_MS
} from '../../shared/agent-prompt-injection'
import { iterateTerminalInputChunks } from '../../shared/terminal-input'

export type RuntimeTerminalWriteOptions = {
  beforeWrite?: (ptyId: string) => void | Promise<void>
  reserveWrite?: (ptyId: string) => void
  afterWrite?: (ptyId: string) => void | Promise<void>
  suffixFailureError?: string
}

export class RuntimeTerminalWriter {
  constructor(private readonly write: (ptyId: string, data: string) => boolean) {}

  async writeAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions = {}
  ): Promise<void> {
    const hasText = typeof action.text === 'string' && action.text.length > 0
    const hasSuffix = action.enter || action.interrupt
    if (hasText) {
      await this.writeChunks(ptyId, action.text!, options)
    }
    if (hasSuffix) {
      const suffix = (action.enter ? '\r' : '') + (action.interrupt ? '\x03' : '')
      if (hasText) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      try {
        await options.beforeWrite?.(ptyId)
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
    await options.beforeWrite?.(ptyId)
    options.reserveWrite?.(ptyId)
    if (!this.write(ptyId, payload)) {
      throw new Error('terminal_not_writable')
    }
    await options.afterWrite?.(ptyId)
  }

  async writeChunks(
    ptyId: string,
    text: string,
    options: RuntimeTerminalWriteOptions = {}
  ): Promise<void> {
    const chunks = iterateTerminalInputChunks(text)
    let chunk = chunks.next()
    while (!chunk.done) {
      await options.beforeWrite?.(ptyId)
      options.reserveWrite?.(ptyId)
      if (!this.write(ptyId, chunk.value)) {
        throw new Error('terminal_not_writable')
      }
      await options.afterWrite?.(ptyId)
      chunk = chunks.next()
      if (!chunk.done) {
        await new Promise((resolve) => setTimeout(resolve, 0))
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
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }
      completedPaste = true
    } catch (error) {
      if (wrotePasteBytes && !completedPaste) {
        this.write(ptyId, AGENT_PROMPT_BRACKETED_PASTE_END)
      }
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, AGENT_PROMPT_SUBMIT_DELAY_MS))
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
