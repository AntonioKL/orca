import type { ComposerModel } from './composer-model'

type MultipleCreateResetInput = Pick<
  ComposerModel,
  | 'handleClearSmartNameSelection'
  | 'lastAutoNameRef'
  | 'nameInputRef'
  | 'refreshFallbackCreatureName'
  | 'setAgentPrompt'
  | 'setAttachmentPaths'
  | 'setCreateError'
  | 'setName'
  | 'setNote'
>

import { useCallback } from 'react'

export function useMultipleCreateReset(input: MultipleCreateResetInput) {
  const {
    handleClearSmartNameSelection,
    lastAutoNameRef,
    nameInputRef,
    refreshFallbackCreatureName,
    setAgentPrompt,
    setAttachmentPaths,
    setCreateError,
    setName,
    setNote
  } = input
  const resetForNextCreate = useCallback(() => {
    // Clear the checkout source too, so a PR's resolved SHA cannot become the next selection.
    handleClearSmartNameSelection()
    refreshFallbackCreatureName()
    setName('')
    lastAutoNameRef.current = ''
    setAgentPrompt('')
    setNote('')
    setAttachmentPaths([])
    setCreateError(null)
    requestAnimationFrame(() => nameInputRef.current?.focus())
  }, [
    handleClearSmartNameSelection,
    lastAutoNameRef,
    nameInputRef,
    refreshFallbackCreatureName,
    setAgentPrompt,
    setAttachmentPaths,
    setCreateError,
    setName,
    setNote
  ])

  return {
    resetForNextCreate
  }
}
