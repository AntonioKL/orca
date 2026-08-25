import type { AskAnswerKeyGroup, AskAnswerSelection, AskPrompt } from './native-chat-ask'

const GROK_ENTER = '\r'
const GROK_NEXT_QUESTION = 'l'
const GROK_FREE_TEXT = 'z'

function optionKey(index: number): string | null {
  if (index >= 0 && index < 9) {
    return String(index + 1)
  }
  if (index >= 9 && index < 15) {
    return String.fromCharCode('a'.charCodeAt(0) + index - 9)
  }
  return null
}

/** Grok picks options by shortcut, moves questions with `l`, and opens free text with `z`. */
export function buildGrokAskAnswerKeys(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerKeyGroup[] {
  const groups: AskAnswerKeyGroup[] = []

  prompt.questions.forEach((question, questionIndex) => {
    const selection = selections[questionIndex]
    const other = (selection?.other ?? '').trim()
    const selectedIndices = question.multiSelect
      ? (selection?.indices ?? [])
      : (selection?.indices.slice(0, 1) ?? [])

    if (!other || question.multiSelect) {
      for (const index of selectedIndices) {
        const key = optionKey(index)
        if (key) {
          groups.push({ raw: key })
        }
      }
    }

    if (other) {
      const freeText = question.multiSelect
        ? other
        : [question.options[selectedIndices[0] ?? -1]?.label, other].filter(Boolean).join(', ')
      groups.push({ raw: GROK_FREE_TEXT }, { text: freeText }, { raw: GROK_ENTER })
    } else if (questionIndex < prompt.questions.length - 1) {
      groups.push({ raw: GROK_NEXT_QUESTION })
    } else if (selectedIndices.length > 0) {
      groups.push({ raw: GROK_ENTER })
    }
  })

  return groups
}
