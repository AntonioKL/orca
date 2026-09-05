import { subagentGroupFallbackText } from '../../../shared/native-chat-subagent-summary'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import type { RuntimeTerminalRead } from '../../../shared/runtime-types'
import type { OrchestrationWorkerReadResult } from '../../../shared/orchestration-worker-output'

export type LegacyWorkerReadResult = {
  dispatchId: string
  terminal: RuntimeTerminalRead
}

export function formatWorkerRead(
  value: OrchestrationWorkerReadResult | LegacyWorkerReadResult
): string {
  if (!('source' in value) || value.source === 'terminal') {
    return value.terminal.tail.join('\n')
  }
  return value.transcript.messages.map(formatWorkerTranscriptMessage).join('\n\n')
}

function formatWorkerTranscriptMessage(message: NativeChatMessage): string {
  // Every roster block is written beside a plain-text twin carrying the same
  // sentence, for clients that cannot draw the block. This CLI is one, so it
  // prints the twin and drops the block — the mirror of the renderer, which
  // draws the block and drops the twin. Either way the sentence prints once.
  const twinTexts = new Set(
    message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  )
  const blocks = message.blocks.flatMap((block): string[] => {
    if (block.type === 'text') {
      return [block.text]
    }
    if (block.type === 'tool-call') {
      return [`[tool ${block.name}] ${safeJson(block.input)}`]
    }
    if (block.type === 'tool-result') {
      return [`[tool result${block.isError ? ' error' : ''}] ${block.output}`]
    }
    if (block.type === 'image-ref') {
      return [block.url ? `[image] ${block.url}` : `[image omitted]`]
    }
    if (block.type === 'subagent-group') {
      // Stand in for the block only when its twin is not already being printed:
      // the wire admits a roster that arrived without one, and dropping that
      // unconditionally would lose the sentence altogether.
      const sentence = subagentGroupFallbackText(block.agents)
      return twinTexts.has(sentence) ? [] : [`[subagents] ${sentence}`]
    }
    // The journal deliberately admits block types this build does not know, and
    // a newer remote host can send one over the wire. Degrade to a marker rather
    // than reading fields off a shape that has none.
    return ['[unsupported block]']
  })
  return `[${message.role}] ${blocks.join('\n')}`.trimEnd()
}

export type WorkerReleaseReceipt = {
  dispatchId: string
  state: string
  reason?: string
  processAction: string
  archive: { source: string | null; status: string | null } | null
  recovery?: string
  lastError?: string
}

export function formatWorkerRelease(value: WorkerReleaseReceipt): string {
  const head = `Worker ${value.dispatchId} terminal [${value.state}]`
  const lines = [
    `${head}${value.reason ? ` reason=${value.reason}` : ''} process=${value.processAction}`
  ]
  if (value.archive) {
    lines.push(`archive ${value.archive.source ?? 'none'} [${value.archive.status ?? 'unknown'}]`)
  }
  if (value.lastError) {
    lines.push(value.lastError)
  }
  if (value.recovery) {
    lines.push(value.recovery)
  }
  return lines.join('\n')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable input]'
  }
}
