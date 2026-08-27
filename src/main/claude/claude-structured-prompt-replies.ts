import type { ClaudeControlRequest } from './claude-stream-json-connection'
import { decodeAgentSessionQuestionOptionId } from '../native-chat/agent-session-wire/agent-session-question-option-id'

export const CLAUDE_APPROVAL_DECISIONS = ['allow', 'allowForSession', 'deny', 'cancel'] as const
export type ClaudeApprovalDecision = (typeof CLAUDE_APPROVAL_DECISIONS)[number]

export type ClaudePendingPrompt = {
  requestId: string
  promptKey: string
  toolUseId: string
  toolName: string
  kind: 'approval' | 'question'
  input: Record<string, unknown>
  suggestions: unknown[]
  questionIds: readonly string[]
  answers: Map<string, string | readonly string[]>
  request: ClaudeControlRequest['request']
}

type PromptBinding = {
  address: string
  questionId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function questionsFrom(input: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(input.questions) ? input.questions.filter(isRecord) : []
}

function questionIdFromAddress(prompt: ClaudePendingPrompt, address: string): string | null {
  const match = /^q([1-9]\d*)$/.exec(address)
  const index = match ? Number(match[1]) - 1 : -1
  return index >= 0 ? (prompt.questionIds[index] ?? null) : null
}

function questionAnswer(prompt: ClaudePendingPrompt, questionId: string, optionId: string): string {
  const decoded = decodeAgentSessionQuestionOptionId(optionId)
  if (!decoded) {
    return optionId
  }
  const questionIndex = prompt.questionIds.indexOf(questionId)
  if (questionIndex === -1) {
    return optionId
  }
  const choice = /^choice-([1-9]\d*)$/.exec(decoded.answer)
  const optionIndex = choice ? Number(choice[1]) - 1 : -1
  const question = questionsFrom(prompt.input)[questionIndex]
  const options = Array.isArray(question?.options) ? question.options : []
  const option = options[optionIndex]
  const label = isRecord(option) ? readString(option.label) : null
  if (decoded.questionId === `q${questionIndex + 1}` && label) {
    return label
  }
  if (decoded.questionId === `q${questionIndex + 1}`) {
    return decoded.answer
  }
  const legacyChoice = options.some(
    (candidate) => isRecord(candidate) && readString(candidate.label) === decoded.answer
  )
  return decoded.questionId === questionId && (legacyChoice || decoded.answer.trim().length > 0)
    ? decoded.answer
    : optionId
}

function questionId(question: Record<string, unknown>, index: number): string {
  return readString(question.question) ?? readString(question.header) ?? `question-${index + 1}`
}

export class ClaudePromptRegistry {
  private readonly prompts = new Map<string, ClaudePendingPrompt>()
  private readonly journalBindings = new Map<string, PromptBinding>()

  register(control: ClaudeControlRequest): ClaudePendingPrompt | null {
    if (control.request.subtype !== 'can_use_tool') {
      return null
    }
    const toolUseId = readString(control.request.tool_use_id)
    const toolName = readString(control.request.tool_name)
    const input = isRecord(control.request.input) ? control.request.input : null
    if (!toolUseId || !toolName || !input) {
      return null
    }
    const questions = toolName === 'AskUserQuestion' ? questionsFrom(input) : []
    const prompt: ClaudePendingPrompt = {
      requestId: control.request_id,
      promptKey: control.request_id,
      toolUseId,
      toolName,
      kind: questions.length > 0 ? 'question' : 'approval',
      input,
      suggestions: Array.isArray(control.request.permission_suggestions)
        ? control.request.permission_suggestions
        : [],
      questionIds: questions.map(questionId),
      answers: new Map(),
      request: control.request
    }
    this.prompts.set(prompt.promptKey, prompt)
    return prompt
  }

  bindJournalItemId(journalItemId: string, promptKey: string, questionIdForItem?: string): void {
    this.journalBindings.set(journalItemId, {
      address: promptKey,
      ...(questionIdForItem ? { questionId: questionIdForItem } : {})
    })
  }

  find(itemId: string): { prompt: ClaudePendingPrompt; questionId?: string } | null {
    const binding = this.journalBindings.get(itemId)
    const prompt = this.prompts.get(binding?.address ?? itemId)
    return prompt
      ? { prompt, ...(binding?.questionId ? { questionId: binding.questionId } : {}) }
      : null
  }

  cancel(requestId: string): ClaudePendingPrompt | null {
    const prompt = this.prompts.get(requestId) ?? null
    if (prompt) {
      this.forget(prompt)
    }
    return prompt
  }

  forget(prompt: ClaudePendingPrompt): void {
    this.prompts.delete(prompt.promptKey)
    for (const [itemId, binding] of this.journalBindings) {
      if (binding.address === prompt.promptKey) {
        this.journalBindings.delete(itemId)
      }
    }
  }

  clear(): ClaudePendingPrompt[] {
    const pending = [...this.prompts.values()]
    this.prompts.clear()
    this.journalBindings.clear()
    return pending
  }
}

function approvalResponse(prompt: ClaudePendingPrompt, optionId: string): Record<string, unknown> {
  if (!(CLAUDE_APPROVAL_DECISIONS as readonly string[]).includes(optionId)) {
    throw new Error(`${optionId} is not a Claude approval decision`)
  }
  const decision = optionId as ClaudeApprovalDecision
  if (decision === 'allow' || decision === 'allowForSession') {
    return {
      behavior: 'allow',
      updatedInput: prompt.input,
      ...(decision === 'allowForSession' && prompt.suggestions.length > 0
        ? { updatedPermissions: prompt.suggestions }
        : {}),
      toolUseID: prompt.toolUseId
    }
  }
  return {
    behavior: 'deny',
    message: decision === 'cancel' ? 'User stopped this turn.' : 'User denied this action.',
    ...(decision === 'cancel' ? { interrupt: true } : {}),
    toolUseID: prompt.toolUseId
  }
}

function questionResponse(
  prompt: ClaudePendingPrompt,
  optionId: string,
  boundQuestionId?: string
): Record<string, unknown> | null {
  const decoded = decodeAgentSessionQuestionOptionId(optionId)
  const decodedQuestionId = decoded
    ? (questionIdFromAddress(prompt, decoded.questionId) ??
      (prompt.questionIds.includes(decoded.questionId) ? decoded.questionId : null))
    : null
  const selectedQuestionId =
    boundQuestionId ??
    decodedQuestionId ??
    (prompt.questionIds.length === 1 ? prompt.questionIds[0] : null)
  if (!selectedQuestionId || !prompt.questionIds.includes(selectedQuestionId)) {
    throw new Error(`${optionId} does not name a question on Claude prompt ${prompt.promptKey}`)
  }
  const answer = questionAnswer(prompt, selectedQuestionId, optionId)
  prompt.answers.set(selectedQuestionId, answer)
  if (prompt.questionIds.some((id) => !prompt.answers.has(id))) {
    return null
  }
  const answers: Record<string, string | readonly string[]> = {}
  for (const id of prompt.questionIds) {
    answers[id] = prompt.answers.get(id) as string
  }
  return {
    behavior: 'allow',
    updatedInput: { ...prompt.input, answers },
    toolUseID: prompt.toolUseId
  }
}

export function applyClaudePromptAnswer(
  found: { prompt: ClaudePendingPrompt; questionId?: string },
  optionId: string
): Record<string, unknown> | null {
  if (found.prompt.kind === 'approval') {
    return approvalResponse(found.prompt, optionId)
  }
  return questionResponse(found.prompt, optionId, found.questionId)
}
