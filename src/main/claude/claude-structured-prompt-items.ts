import type {
  AgentJournalApprovalItem,
  AgentJournalItemIdentity,
  AgentJournalPromptOption,
  AgentJournalQuestionItem
} from '../../shared/agent-session-journal-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { claudeRecord, claudeText } from './claude-structured-item-translation'
import {
  CLAUDE_APPROVAL_DECISIONS,
  type ClaudeApprovalDecision,
  type ClaudePendingPrompt
} from './claude-structured-prompt-replies'
import { encodeAgentSessionQuestionOptionId } from '../native-chat/agent-session-wire/agent-session-question-option-id'

const APPROVAL_LABELS: Record<ClaudeApprovalDecision, string> = {
  allow: 'Allow',
  allowForSession: 'Allow for this session',
  deny: 'Deny',
  cancel: 'Stop'
}

const PENDING = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

export function claudePromptIdentity(input: {
  sessionId: string
  promptKey: string
  questionId?: string
}): AgentJournalItemIdentity {
  const suffix = input.questionId ? `:${input.questionId}` : ''
  return {
    provider: 'orca',
    clientMessageId: `claude-prompt:${input.sessionId}:${input.promptKey}${suffix}`
  }
}

export function claudeApprovalItem(prompt: ClaudePendingPrompt): AgentJournalApprovalItem {
  const serialized = JSON.stringify(prompt.input)
  return {
    kind: 'approval',
    title: `Allow ${prompt.toolName}?`,
    detail: serialized ? boundInlineText(serialized, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text : null,
    options: CLAUDE_APPROVAL_DECISIONS.map((decision) => ({
      id: decision,
      label: APPROVAL_LABELS[decision]
    })),
    resolution: { ...PENDING }
  }
}

export type ClaudeQuestionItem = {
  identity: AgentJournalItemIdentity
  body: AgentJournalQuestionItem
}

function questionOptions(
  question: Record<string, unknown>,
  questionAddress: string
): AgentJournalPromptOption[] {
  if (!Array.isArray(question.options)) {
    return []
  }
  return question.options.flatMap((value, index) => {
    const option = claudeRecord(value)
    const label = claudeText(option?.label)
    return label
      ? [
          {
            id: encodeAgentSessionQuestionOptionId(questionAddress, `choice-${index + 1}`),
            label
          }
        ]
      : []
  })
}

export function claudeQuestionItems(input: {
  sessionId: string
  prompt: ClaudePendingPrompt
}): ClaudeQuestionItem[] {
  const values = Array.isArray(input.prompt.input.questions) ? input.prompt.input.questions : []
  return values.flatMap((value, index): ClaudeQuestionItem[] => {
    const question = claudeRecord(value)
    const questionAddress = `q${index + 1}`
    const text = claudeText(question?.question) ?? claudeText(question?.header)
    const header = claudeText(question?.header)
    return question && input.prompt.questionIds[index] && text
      ? [
          {
            identity: claudePromptIdentity({
              sessionId: input.sessionId,
              promptKey: input.prompt.promptKey,
              questionId: questionAddress
            }),
            body: {
              kind: 'question',
              question: header ? `${header}: ${text}` : text,
              options: questionOptions(question, questionAddress),
              freeTextQuestionId: questionAddress,
              resolution: { ...PENDING }
            }
          }
        ]
      : []
  })
}
