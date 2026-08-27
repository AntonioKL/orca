/** A user-input request can carry several questions but takes ONE reply, so an
 *  option id has to name the question it answers. Provider-agnostic: the shared
 *  turn path decodes ids from every adapter, so the codec cannot live in one. */
export function encodeAgentSessionQuestionOptionId(questionId: string, answer: string): string {
  return `${encodeURIComponent(questionId)}:${encodeURIComponent(answer)}`
}

export function decodeAgentSessionQuestionOptionId(
  optionId: string
): { questionId: string; answer: string } | null {
  const separator = optionId.indexOf(':')
  if (separator <= 0) {
    return null
  }
  try {
    return {
      questionId: decodeURIComponent(optionId.slice(0, separator)),
      answer: decodeURIComponent(optionId.slice(separator + 1))
    }
  } catch {
    return null
  }
}
